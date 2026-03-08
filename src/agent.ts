import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import type { Config } from './types.js';
import type { Memory } from './memory.js';

const MAX_TURNS = 20;
const SERVER_NAME = 'secret-agent-tools';

interface ExternalMcpServer {
  type: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type StreamCallback = (textDelta: string) => void;

export class Agent {
  private externalMcpCache: Record<string, ExternalMcpServer> | null = null;
  private externalMcpMtime = 0;

  constructor(
    private config: Config,
    private memory: Memory,
    private toolServer: unknown,
    private state: { chatId: string },
  ) {}

  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    const soul = this.memory.getSoul();
    if (soul) parts.push(soul);

    const mem = this.memory.getMemory();
    if (mem) parts.push(`\n## Long-term Memory\n${mem}`);

    const recentLogs = await this.memory.getRecentLogs();
    if (recentLogs) parts.push(`\n## Recent Activity\n${recentLogs}`);

    parts.push(`\nCurrent date/time: ${new Date().toISOString()}`);

    return parts.join('\n');
  }

  private async loadExternalMcpServers(): Promise<Record<string, ExternalMcpServer>> {
    const mcpPath = path.join(this.config.workspaceDir, 'mcp.json');
    if (!existsSync(mcpPath)) return {};
    try {
      // Only re-read if file has changed
      const mtime = statSync(mcpPath).mtimeMs;
      if (this.externalMcpCache && mtime === this.externalMcpMtime) {
        return this.externalMcpCache;
      }
      const content = await readFile(mcpPath, 'utf-8');
      this.externalMcpCache = JSON.parse(content);
      this.externalMcpMtime = mtime;
      return this.externalMcpCache!;
    } catch (err) {
      console.error('[agent] Failed to load mcp.json:', err);
      return {};
    }
  }

  async run(
    prompt: string,
    sessionId: string | undefined,
    chatId: string,
    model?: string,
    onStream?: StreamCallback,
  ): Promise<{ response: string; sessionId: string }> {
    this.state.chatId = chatId;

    let resultText = '';
    let newSessionId = sessionId || '';

    const externalServers = await this.loadExternalMcpServers();
    const allowedTools: string[] = [`mcp__${SERVER_NAME}__*`, 'Read'];
    const mcpServers: Record<string, unknown> = { [SERVER_NAME]: this.toolServer };

    for (const [name, serverConfig] of Object.entries(externalServers)) {
      allowedTools.push(`mcp__${name}__*`);
      mcpServers[name] = serverConfig;
    }

    const options: Record<string, unknown> = {
      systemPrompt: await this.buildSystemPrompt(),
      model: model || this.config.model,
      maxTurns: MAX_TURNS,
      allowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers,
      includePartialMessages: !!onStream,
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    try {
      for await (const message of query({ prompt, options: options as any })) {
        const msg = message as Record<string, unknown>;
        if (msg.type === 'system' && msg.subtype === 'init') {
          newSessionId = msg.session_id as string;
          console.log('[agent] session:', newSessionId);
        } else if (msg.type === 'stream_event' && onStream) {
          // Extract text deltas from streaming events
          const event = msg.event as Record<string, unknown> | undefined;
          if (event?.type === 'content_block_delta') {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              onStream(delta.text);
            }
          }
        } else if ('result' in msg) {
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
