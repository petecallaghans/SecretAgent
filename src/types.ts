export interface Config {
  telegramBotToken: string;
  allowedUsers: number[];
  model: string;
  maxTokens: number;
  workspaceDir: string;
  dataDir: string;
  shellAllowlist: string[];
}

export interface CronJobDef {
  id: string;
  schedule: string;
  prompt: string;
  chatId: number;
  enabled: boolean;
}

export function loadConfig(): Config {
  return {
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
    model: process.env.MODEL || 'claude-sonnet-4-5',
    maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
    workspaceDir: process.env.WORKSPACE_DIR || './workspace',
    dataDir: process.env.DATA_DIR || './data',
    shellAllowlist: (process.env.SHELL_ALLOWLIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  };
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
