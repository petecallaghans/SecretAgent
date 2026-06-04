import 'dotenv/config';
// Allow running inside a Claude Code session (e.g. during development)
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
import { loadConfig } from './types.js';
import { SessionManager } from './sessions.js';
import { Memory } from './memory.js';
import { Agent } from './agent.js';
import { CronScheduler } from './cron.js';
import { WebhookServer } from './webhook.js';
import { Gateway } from './gateway.js';
import { TelegramAdapter } from './telegram.js';
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

  // Late-binding references (needed because telegram/gateway are created after toolServer)
  let telegramRef: TelegramAdapter | undefined;
  let gatewayRef: Gateway | undefined;

  const toolServer = createToolServer(config, memory, {
    cronHandler: (action, input) => cronScheduler.handleToolAction(action, input),
    webhookHandler: (action, input) => webhookServer.handleToolAction(action, input),
    getChatId: () => state.chatId,
    sendFile: async (chatId, filePath, caption) => {
      if (!telegramRef) throw new Error('Telegram not initialized');
      await telegramRef.sendFile(chatId, filePath, caption);
    },
    requestApproval: async (chatId, description) => {
      if (!telegramRef) throw new Error('Telegram not initialized');
      return telegramRef.requestApproval(chatId, description);
    },
    isApprovalEnabled: (chatId) => gatewayRef?.getApproval(chatId) ?? false,
    getPeerContext: () => state.peer,
    mirrorPeer: async (text) => {
      if (!roster || !telegramRef) return;
      await telegramRef.sendMessage(Number(roster.groupChatId), text);
    },
  }, roster);

  const agent = new Agent(config, memory, toolServer, state, roster);

  const gateway = new Gateway(config, sessions, agent, memory, roster);
  gatewayRef = gateway;
  gateway.setCronScheduler(cronScheduler);
  gateway.setWebhookServer(webhookServer);

  const telegram = new TelegramAdapter(config, gateway, roster);
  telegramRef = telegram;

  // Wire cron jobs to send results via Telegram
  cronScheduler.setFireHandler(async (job) => {
    console.log(`Cron fired: ${job.id} - "${job.prompt}"`);
    try {
      const response = await gateway.handleMessage(job.chatId.toString(), job.prompt, undefined, 'cron');
      await telegram.sendMessage(job.chatId, response);
    } catch (err) {
      console.error(`Cron ${job.id} failed:`, err);
    }
  });

  // Wire webhooks to send results via Telegram
  webhookServer.setFireHandler(async (webhook, prompt) => {
    try {
      const response = await gateway.handleMessage(webhook.chatId.toString(), prompt, undefined, 'webhook');
      await telegram.sendMessage(webhook.chatId, response);
    } catch (err) {
      console.error(`Webhook ${webhook.id} failed:`, err);
    }
  });

  // Wire inbound peer messages: process via the gateway, post the reply to the group.
  if (roster) {
    webhookServer.setPeerHandler(async (env) => {
      try {
        const response = await gateway.handlePeerMessage(env);
        if (response) await telegram.sendMessage(Number(roster.groupChatId), response);
      } catch (err) {
        console.error(`Peer message ${env.msgId} failed:`, err);
      }
    });
  }

  await cronScheduler.init();
  await webhookServer.init();

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
    // Stop bot polling — grammy waits for in-flight handlers to finish
    telegram.stop();
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

  // Start bot (blocks until stopped)
  await telegram.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
