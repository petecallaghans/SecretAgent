export type Effort = 'low' | 'medium' | 'high' | 'max';
export type ThinkingMode = 'adaptive' | 'disabled';

export interface Config {
  telegramBotToken: string;
  allowedUsers: number[];
  model: string;
  maxTokens: number;
  workspaceDir: string;
  dataDir: string;
  shellAllowlist: string[];
  webhookPort: number;
  openaiApiKey: string;
  effort: Effort;
  thinking: ThinkingMode;
}

export interface CronJobDef {
  id: string;
  schedule: string;
  prompt: string;
  chatId: number;
  enabled: boolean;
}

export interface WebhookDef {
  id: string;
  path: string;
  prompt: string;
  chatId: number;
  secret?: string;
}

export function loadConfig(): Config {
  return {
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
    model: process.env.MODEL || 'claude-opus-4-6',
    maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
    workspaceDir: process.env.WORKSPACE_DIR || './workspace',
    dataDir: process.env.DATA_DIR || './data',
    shellAllowlist: (process.env.SHELL_ALLOWLIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    webhookPort: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    effort: (process.env.EFFORT as Effort) || 'low',
    thinking: (process.env.THINKING as ThinkingMode) || 'disabled',
  };
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
