import 'dotenv/config';
// Allow running inside a Claude Code session (e.g. during development)
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
import { loadConfig } from './types.js';
import { SessionManager } from './sessions.js';
import { Memory } from './memory.js';
import { Agent } from './agent.js';
import { CronScheduler } from './cron.js';
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

  // Shared mutable state for passing chatId to tool handlers
  const state = { chatId: '' };

  const toolServer = createToolServer(
    config,
    memory,
    (action, input) => cronScheduler.handleToolAction(action, input),
    () => state.chatId,
  );

  const agent = new Agent(config, memory, toolServer, state);

  const gateway = new Gateway(config, sessions, agent, memory);
  gateway.setCronScheduler(cronScheduler);

  const telegram = new TelegramAdapter(config, gateway);

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

  await cronScheduler.init();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    telegram.stop();
    cronScheduler.stopAll();
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
