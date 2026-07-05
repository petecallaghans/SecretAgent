import 'dotenv/config';
import cron from 'node-cron';
// Allow running inside a Claude Code session (e.g. during development)
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
import { loadConfig } from './types.js';
import { SessionManager } from './sessions.js';
import { PrefsStore } from './prefs.js';
import { Memory } from './memory.js';
import { Agent } from './agent.js';
import { CronScheduler } from './cron.js';
import { WebhookServer } from './webhook.js';
import { Gateway } from './gateway.js';
import { TelegramAdapter } from './telegram.js';
import { SlackAdapter } from './channels/slack.js';
import { ChannelRegistry } from './channels/registry.js';
import { createToolServer } from './tools/index.js';
import { Roster } from './roster.js';
import type { AgentState } from './types.js';

async function main() {
  const config = loadConfig();
  console.log('Starting SecretAgent...');
  console.log(`  Models: light=${config.modelLight} default=${config.modelDefault} deep=${config.modelDeep}`);
  console.log(`  Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '(all)'}`);
  console.log(`  Workspace: ${config.workspaceDir}`);

  // Initialize components
  const sessions = new SessionManager(config);
  await sessions.init();

  const prefs = new PrefsStore(config);
  await prefs.init();

  const memory = new Memory(config);
  await memory.init();

  // Optional team roster — null means single-agent (classic) behavior.
  const roster = await Roster.load(config);
  if (roster) {
    const teammates = roster.peers.map(p => `${p.name} (${p.role})`).join(', ') || '(none)';
    console.log(`  Team: I am ${roster.self.name} (${roster.self.role}); teammates: ${teammates}`);
  }

  const cronScheduler = new CronScheduler(config);
  const webhookServer = new WebhookServer(config, roster);

  // Shared mutable state for passing chatId + peer context to tool handlers
  const state: AgentState = { chatId: '' };

  // Late-binding references (needed because channels/gateway are created after toolServer)
  const channels = new ChannelRegistry();
  let gatewayRef: Gateway | undefined;

  const toolServer = createToolServer(config, memory, {
    cronHandler: (action, input) => cronScheduler.handleToolAction(action, input),
    webhookHandler: (action, input) => webhookServer.handleToolAction(action, input),
    getChatId: () => state.chatId,
    sendFile: async (chatId, filePath, caption) => {
      await channels.resolve(chatId).sendFile(chatId, filePath, caption);
    },
    requestApproval: async (chatId, description) => {
      return channels.resolve(chatId).requestApproval(chatId, description);
    },
    isApprovalEnabled: (chatId) => gatewayRef?.getApproval(chatId) ?? false,
    getPeerContext: () => state.peer,
    mirrorPeer: async (text) => {
      if (!roster) return;
      await channels.resolve(roster.groupChatId).sendMessage(roster.groupChatId, text);
    },
  }, roster);

  const agent = new Agent(config, memory, toolServer, state, roster);

  const gateway = new Gateway(config, sessions, agent, memory, roster, prefs);
  gatewayRef = gateway;
  gateway.setCronScheduler(cronScheduler);
  gateway.setWebhookServer(webhookServer);

  const telegram = new TelegramAdapter(config, gateway, roster);
  channels.register(telegram);

  // Slack lives alongside Telegram when both tokens are configured.
  if (config.slackBotToken && config.slackAppToken) {
    channels.register(new SlackAdapter(config, gateway));
  }

  // Wire cron jobs to send results back to their originating chat
  cronScheduler.setFireHandler(async (job) => {
    console.log(`Cron fired: ${job.id} - "${job.prompt}"`);
    const chatId = String(job.chatId);
    try {
      const response = await gateway.handleMessage(chatId, job.prompt, undefined, 'cron');
      await channels.resolve(chatId).sendMessage(chatId, response);
    } catch (err) {
      console.error(`Cron ${job.id} failed:`, err);
    }
  });

  // Wire webhooks to send results back to their originating chat
  webhookServer.setFireHandler(async (webhook, prompt) => {
    const chatId = String(webhook.chatId);
    try {
      const response = await gateway.handleMessage(chatId, prompt, undefined, 'webhook');
      await channels.resolve(chatId).sendMessage(chatId, response);
    } catch (err) {
      console.error(`Webhook ${webhook.id} failed:`, err);
    }
  });

  // Wire inbound peer messages: process via the gateway, post the reply to the group.
  if (roster) {
    webhookServer.setPeerHandler(async (env) => {
      try {
        const response = await gateway.handlePeerMessage(env);
        if (response) {
          await channels.resolve(roster.groupChatId).sendMessage(roster.groupChatId, response);
        }
      } catch (err) {
        console.error(`Peer message ${env.msgId} failed:`, err);
      }
    });
  }

  await cronScheduler.init();
  await webhookServer.init();

  // Nightly memory distillation: fold yesterday's log into topic files + index.
  // Runs as a fresh one-shot session on the light model; silent unless it fails.
  if (config.memoryDistillCron) {
    if (cron.validate(config.memoryDistillCron)) {
      cron.schedule(config.memoryDistillCron, () => {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const prompt = [
          `System: nightly memory distillation for ${yesterday}.`,
          `1. Read that day's log with read_log("${yesterday}"). If empty, reply "DONE".`,
          '2. Extract durable facts (preferences, people, projects, decisions, reference info).',
          '3. Write each into the matching memory/topics/<slug>.md via write_file (create or update; merge, don\'t duplicate).',
          '4. Update the memory.md index via save_memory: one line per topic file with a short hook, under ~30 lines total.',
          '5. If memory.md still contains long-form content beyond index lines, migrate it into topic files now.',
          'Reply "DONE" when finished.',
        ].join('\n');
        gateway.handleMessage('0', prompt, undefined, 'system', 'distill').then(
          () => console.log('[distill] Nightly memory distillation completed'),
          (err) => console.error('[distill] Nightly memory distillation failed:', err),
        );
      });
      console.log(`  Memory distill: ${config.memoryDistillCron}`);
    } else {
      console.warn(`  Invalid MEMORY_DISTILL_CRON "${config.memoryDistillCron}" — distillation disabled`);
    }
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n${signal} again — forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    // Stop accepting new triggers (cron fires + webhook HTTP)
    cronScheduler.stopAll();
    webhookServer.stop();
    // Stop channel adapters — grammy waits for in-flight handlers to finish
    for (const adapter of channels.all()) adapter.stop();
    // Drain in-flight + queued agent messages
    try {
      await gateway.drain(30_000);
    } catch (err) {
      console.error('[shutdown] drain error:', err);
    }
    agent.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  // Start non-blocking adapters first (Slack socket mode), then Telegram
  // long polling, which blocks until stopped.
  for (const adapter of channels.all()) {
    if (adapter !== telegram) await adapter.start();
  }
  await telegram.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
