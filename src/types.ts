export type Effort = 'low' | 'medium' | 'high' | 'max';
export type ThinkingMode = 'adaptive' | 'disabled';

export interface Config {
  telegramBotToken: string;
  allowedUsers: number[];
  modelDefault: string;
  modelLight: string;
  modelDeep: string;
  maxTokens: number;
  workspaceDir: string;
  dataDir: string;
  shellAllowlist: string[];
  webhookPort: number;
  braveApiKey: string;
  memoryDistillCron: string;
  sessionMaxMessages: number;
  slackBotToken: string;
  slackAppToken: string;
  slackAllowedUsers: string[];
  openaiApiKey: string;
  openaiDelegateNano: string;
  openaiDelegateMini: string;
  openaiDelegateSmart: string;
  effort: Effort;
  thinking: ThinkingMode;
}

export interface CronJobDef {
  id: string;
  schedule: string;
  prompt: string;
  /** Namespaced chat id; legacy entries hold bare Telegram numbers. */
  chatId: number | string;
  enabled: boolean;
}

export interface WebhookDef {
  id: string;
  path: string;
  prompt: string;
  /** Namespaced chat id; legacy entries hold bare Telegram numbers. */
  chatId: number | string;
  secret?: string;
}

/** Agent↔agent message envelope, carried over the private /peer HTTP channel. */
export interface PeerMessage {
  msgId: string;
  from: string; // sender agent id
  to: string; // recipient agent id
  message: string; // natural-language content
  payload?: unknown; // optional structured data (user-defined; framework-agnostic)
  replyTo?: string; // msgId this responds to (threads a conversation)
  chainId: string; // root of the conversation; scopes the receiver's session
  hops: number; // incremented each relay; used for loop control
}

/** Per-run peer context, set on shared state so message_peer can thread replies. */
export interface PeerContext {
  chainId: string;
  hops: number; // hops of the inbound message that triggered this run
  replyTo?: string; // msgId of the inbound message (so replies thread)
}

/** Mutable state shared between Agent and the tool server for the active run. */
export interface AgentState {
  chatId: string;
  peer?: PeerContext;
}

export function loadConfig(): Config {
  return {
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
    modelDefault: process.env.MODEL_DEFAULT || process.env.MODEL || 'claude-opus-4-6',
    modelLight: process.env.MODEL_LIGHT || 'claude-haiku-4-5',
    modelDeep: process.env.MODEL_DEEP || 'claude-opus-4-6',
    maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
    workspaceDir: process.env.WORKSPACE_DIR || './workspace',
    dataDir: process.env.DATA_DIR || './data',
    shellAllowlist: (process.env.SHELL_ALLOWLIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    webhookPort: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    braveApiKey: process.env.BRAVE_API_KEY || '',
    memoryDistillCron: process.env.MEMORY_DISTILL_CRON ?? '30 3 * * *',
    sessionMaxMessages: parseInt(process.env.SESSION_MAX_MESSAGES || '40', 10),
    slackBotToken: process.env.SLACK_BOT_TOKEN || '',
    slackAppToken: process.env.SLACK_APP_TOKEN || '',
    slackAllowedUsers: (process.env.SLACK_ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiDelegateNano: process.env.OPENAI_DELEGATE_NANO || 'gpt-5.4-nano',
    openaiDelegateMini: process.env.OPENAI_DELEGATE_MINI || 'gpt-5-mini',
    openaiDelegateSmart: process.env.OPENAI_DELEGATE_SMART || 'gpt-5.4-mini',
    effort: (process.env.EFFORT as Effort) || 'medium',
    thinking: (process.env.THINKING as ThinkingMode) || 'disabled',
  };
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
