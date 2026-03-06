import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './types.js';
import type { Memory } from './memory.js';

const MAX_TURNS = 20;
const SERVER_NAME = 'secret-agent-tools';

export class Agent {
  constructor(
    private config: Config,
    private memory: Memory,
    private toolServer: unknown,
    private state: { chatId: string },
  ) {}

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    const soul = this.memory.getSoul();
    if (soul) parts.push(soul);

    const mem = this.memory.getMemory();
    if (mem) parts.push(`\n## Long-term Memory\n${mem}`);

    parts.push(`\nCurrent date/time: ${new Date().toISOString()}`);

    return parts.join('\n');
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    chatId: string,
    model?: string,
  ): Promise<{ response: string; sessionId: string }> {
    this.state.chatId = chatId;

    let resultText = '';
    let newSessionId = sessionId || '';

    const options: Record<string, unknown> = {
      systemPrompt: this.buildSystemPrompt(),
      model: model || this.config.model,
      maxTurns: MAX_TURNS,
      allowedTools: [`mcp__${SERVER_NAME}__*`, 'Read'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers: { [SERVER_NAME]: this.toolServer },
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    try {
      for await (const message of query({ prompt, options: options as any })) {
        const msg = message as Record<string, unknown>;
        console.log('[agent] message:', JSON.stringify(msg).slice(0, 500));
        if (msg.type === 'system' && msg.subtype === 'init') {
          newSessionId = msg.session_id as string;
        }
        if ('result' in msg) {
          resultText = msg.result as string;
        }
      }
    } catch (err) {
      console.error('[agent] query() error:', err);
      throw err;
    }

    return { response: resultText, sessionId: newSessionId };
  }
}
