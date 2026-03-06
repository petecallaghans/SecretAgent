import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function print(text: string): void {
  console.log(text);
}

function printHeader(text: string): void {
  print(`\n${text}`);
  print('-'.repeat(text.length));
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  print('\nSecretAgent Setup');
  print('=================\n');

  // Step 1: Claude Code Authentication
  printHeader('Step 1: Claude Code Authentication');
  print('SecretAgent uses Claude Code to connect to Claude.');
  print('Checking if Claude Code is installed...\n');

  if (!commandExists('claude')) {
    print('Claude Code is not installed.');
    print('Install it: npm install -g @anthropic-ai/claude-code');
    print('Then run: claude login');
    print('You need a Claude Max or Team subscription.\n');
    rl.close();
    process.exit(1);
  }
  print('  ✓ Claude Code found\n');

  print('Checking authentication...');
  try {
    const output = execSync('claude auth status 2>&1', { encoding: 'utf-8' });
    if (output.toLowerCase().includes('not logged in') || output.toLowerCase().includes('no auth')) {
      throw new Error('not logged in');
    }
    print('  ✓ Authenticated\n');
  } catch {
    print('  ✗ Not logged in.\n');
    print('  Run: claude login');
    print('  You need a Claude Max or Team subscription.\n');
    await ask('  Press Enter when done...');

    // Check again
    try {
      execSync('claude auth status 2>&1', { encoding: 'utf-8' });
      print('  ✓ Authenticated\n');
    } catch {
      print('  Still not authenticated. Please run "claude login" and try setup again.\n');
      rl.close();
      process.exit(1);
    }
  }

  // Step 2: Telegram Bot
  printHeader('Step 2: Telegram Bot');
  print('You need a Telegram bot token. If you don\'t have one:');
  print('  1. Open Telegram and message @BotFather');
  print('  2. Send /newbot and follow the prompts');
  print('  3. Copy the token it gives you\n');

  let token = '';
  while (!token) {
    token = await ask('  Bot token: ');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      print('  Invalid token format. Should look like: 123456:ABC-DEF...');
      token = '';
    }
  }
  print('  ✓ Token saved\n');

  // Step 3: Telegram User ID
  printHeader('Step 3: Telegram User ID (optional)');
  print('Restrict the bot to specific Telegram users.');
  print('To find your user ID, message @userinfobot on Telegram.\n');

  const userIdInput = await ask('  Your Telegram user ID (Enter to allow all users): ');
  const allowedUsers = userIdInput
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (allowedUsers.length > 0) {
    print(`  ✓ Restricted to: ${allowedUsers.join(', ')}\n`);
  } else {
    print('  ✓ All users allowed\n');
  }

  // Step 4: Write Config
  printHeader('Step 4: Writing Configuration');

  const envPath = path.resolve('.env');
  if (existsSync(envPath)) {
    const overwrite = await ask('  .env already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      print('  Keeping existing .env\n');
      rl.close();
      print('\nSetup complete! Run: npm run dev\n');
      return;
    }
  }

  const envContent = [
    `TELEGRAM_BOT_TOKEN=${token}`,
    `ALLOWED_USERS=${allowedUsers.join(',')}`,
    `MODEL=claude-sonnet-4-5`,
    `MAX_TOKENS=8192`,
    `WORKSPACE_DIR=./workspace`,
    `DATA_DIR=./data`,
    `SHELL_ALLOWLIST=`,
  ].join('\n') + '\n';

  writeFileSync(envPath, envContent);
  print('  ✓ .env written\n');

  // Create workspace and data dirs
  mkdirSync('workspace', { recursive: true });
  mkdirSync('data', { recursive: true });
  print('  ✓ workspace/ and data/ directories ready\n');

  rl.close();

  print('━'.repeat(40));
  print('\n  Setup complete!\n');
  print('  Next steps:');
  print('    npm run dev     # start the bot');
  print('    Message your bot on Telegram');
  print('    It will walk you through personalizing it\n');
}

main().catch((err) => {
  console.error('Setup error:', err);
  rl.close();
  process.exit(1);
});
