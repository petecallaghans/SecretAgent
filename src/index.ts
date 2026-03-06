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

async function main() {
  const config = loadConfig();
  console.log('Starting SecretAgent...');
  console.log(`  Model: ${config.model}`);
  console.log(`  Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '(all)'}`);
  console.log(`  Workspace: ${config.workspaceDir}`);

  // Initialize components
  const sessions = new SessionManager(config);
  await sessions.init();

  const memory = new Memory(config);
  await memory.init();

  const cronScheduler = new CronScheduler(config);
  const webhookServer = new WebhookServer(config);

  // Shared mutable state for passing chatId to tool handlers
  const state = { chatId: '' };

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
  });

  const agent = new Agent(config, memory, toolServer, state);

  const gateway = new Gateway(config, sessions, agent, memory);
  gatewayRef = gateway;
  gateway.setCronScheduler(cronScheduler);
  gateway.setWebhookServer(webhookServer);

  const telegram = new TelegramAdapter(config, gateway);
  telegramRef = telegram;

  // Wire cron jobs to send results via Telegram
  cronScheduler.setFireHandler(async (job) => {
    console.log(`Cron fired: ${job.id} - "${job.prompt}"`);
    try {
      const response = await gateway.handleMessage(job.chatId.toString(), job.prompt);
      await telegram.sendMessage(job.chatId, response);
    } catch (err) {
      console.error(`Cron ${job.id} failed:`, err);
    }
  });

  // Wire webhooks to send results via Telegram
  webhookServer.setFireHandler(async (webhook, prompt) => {
    try {
      const response = await gateway.handleMessage(webhook.chatId.toString(), prompt);
      await telegram.sendMessage(webhook.chatId, response);
    } catch (err) {
      console.error(`Webhook ${webhook.id} failed:`, err);
    }
  });

  await cronScheduler.init();
  await webhookServer.init();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    telegram.stop();
    cronScheduler.stopAll();
    webhookServer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start bot (blocks until stopped)
  await telegram.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
