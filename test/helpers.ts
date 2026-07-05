import type { Config } from '../src/types.js';

/** Full Config for tests — override per test as needed. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'x',
    allowedUsers: [],
    modelDefault: 'claude-opus-4-6',
    modelLight: 'claude-haiku-4-5',
    modelDeep: 'claude-opus-4-6',
    maxTokens: 8192,
    workspaceDir: './workspace',
    dataDir: './data',
    shellAllowlist: [],
    webhookPort: 3000,
    braveApiKey: '',
    memoryDistillCron: '',
    sessionMaxMessages: 0,
    slackBotToken: '',
    slackAppToken: '',
    slackAllowedUsers: [],
    openaiApiKey: '',
    openaiDelegateNano: 'gpt-5.4-nano',
    openaiDelegateMini: 'gpt-5-mini',
    openaiDelegateSmart: 'gpt-5.4-mini',
    effort: 'low',
    thinking: 'disabled',
    ...overrides,
  };
}
