import { query, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import type { Config } from './types.js';
import type { Memory } from './memory.js';

const SERVER_NAME = 'secret-agent-tools';

/** Scale maxTurns by effort — simple chats shouldn't loop through many tool calls */
const EFFORT_MAX_TURNS: Record<string, number> = {
  low: 5,
  medium: 10,
  high: 20,
  max: 30,
};

/** Scale maxTokens by effort — shorter responses for simple exchanges */
const EFFORT_MAX_TOKENS: Record<string, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16384,
};

interface ExternalMcpServer {
  type: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type StreamCallback = (textDelta: string) => void;

/**
 * Pre-warms Claude Code processes to eliminate subprocess startup latency.
 * Spawns a process in advance and hands it to the SDK when query() requests one.
 */
class ProcessPool {
  private warm: { process: ReturnType<typeof spawn>; spawnOpts?: SpawnOptions } | null = null;
  private lastCommand: string | null = null;
  private lastArgs: string[] | null = null;

  /**
   * Pre-spawn a process using the command/args from the last query.
   * Called after each query completes so the next one is ready immediately.
   */
  prewarm(opts: SpawnOptions): void {
    if (this.warm) return; // already warm
    this.lastCommand = opts.command;
    this.lastArgs = [...opts.args];
    try {
      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.warm = { process: child, spawnOpts: opts };
      child.on('exit', () => {
        if (this.warm?.process === child) this.warm = null;
      });
      child.on('error', () => {
        if (this.warm?.process === child) this.warm = null;
      });
      console.log('[pool] Pre-warmed process spawned');
    } catch {
      this.warm = null;
    }
  }

  /**
   * Called by the SDK via spawnClaudeCodeProcess. Returns a pre-warmed process
   * if available, otherwise spawns a fresh one and saves opts for next prewarm.
   */
  acquire(opts: SpawnOptions): SpawnedProcess {
    this.lastCommand = opts.command;
    this.lastArgs = [...opts.args];

    if (this.warm) {
      console.log('[pool] Reusing pre-warmed process');
      const child = this.warm.process;
      this.warm = null;
      return child as unknown as SpawnedProcess;
    }

    console.log('[pool] Cold spawn (no pre-warmed process available)');
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child as unknown as SpawnedProcess;
  }

  /**
   * Schedule a prewarm using the last seen spawn options.
   */
  schedulePrewarm(opts: SpawnOptions): void {
    // Small delay to let the previous process fully clean up
    setTimeout(() => this.prewarm(opts), 100);
  }

  dispose(): void {
    if (this.warm) {
      this.warm.process.kill('SIGTERM');
      this.warm = null;
    }
  }
}

export class Agent {
  private externalMcpCache: Record<string, ExternalMcpServer> | null = null;
  private externalMcpMtime = 0;
  private pool = new ProcessPool();
  private lastSpawnOpts: SpawnOptions | null = null;
  private cachedSystemPrompt = '';
  private systemPromptExpiry = 0;

  constructor(
    private config: Config,
    private memory: Memory,
    private toolServer: unknown,
    private state: { chatId: string },
  ) {}

  private async buildSystemPrompt(): Promise<string> {
    const now = Date.now();
    // Cache system prompt for 30s — avoids re-reading log files every message
    if (this.cachedSystemPrompt && now < this.systemPromptExpiry) {
      return this.cachedSystemPrompt;
    }

    const parts: string[] = [];

    const soul = this.memory.getSoul();
    if (soul) parts.push(soul);

    const tools = this.memory.getTools();
    if (tools) parts.push(`\n## Tools & Instructions\nIMPORTANT: Follow these instructions carefully — they define your available tools and behavioral rules.\n${tools}`);

    const mem = this.memory.getMemory();
    if (mem) parts.push(`\n## Long-term Memory\n${mem}`);

    const recentLogs = await this.memory.getRecentLogs();
    if (recentLogs) parts.push(`\n## Recent Activity\n${recentLogs}`);

    parts.push(`\nCurrent date/time: ${new Date().toISOString()}`);

    this.cachedSystemPrompt = parts.join('\n');
    this.systemPromptExpiry = now + 30_000;
    return this.cachedSystemPrompt;
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
    let streamedText = '';
    let newSessionId = sessionId || '';

    const externalServers = await this.loadExternalMcpServers();
    const allowedTools: string[] = [`mcp__${SERVER_NAME}__*`, 'Read'];
    const mcpServers: Record<string, unknown> = { [SERVER_NAME]: this.toolServer };

    for (const [name, serverConfig] of Object.entries(externalServers)) {
      allowedTools.push(`mcp__${name}__*`);
      mcpServers[name] = serverConfig;
    }

    // Build thinking config from settings
    const thinking = this.config.thinking === 'disabled'
      ? { type: 'disabled' as const }
      : { type: 'adaptive' as const };

    const effort = this.config.effort;
    const maxTurns = EFFORT_MAX_TURNS[effort] ?? 10;
    const maxTokens = Math.min(
      EFFORT_MAX_TOKENS[effort] ?? 4096,
      this.config.maxTokens,
    );

    const options: Record<string, unknown> = {
      systemPrompt: await this.buildSystemPrompt(),
      model: model || this.config.model,
      maxTurns,
      maxTokens,
      allowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers,
      includePartialMessages: !!onStream,
      effort,
      thinking,
      spawnClaudeCodeProcess: (opts: SpawnOptions) => {
        this.lastSpawnOpts = opts;
        return this.pool.acquire(opts);
      },
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
              streamedText += delta.text;
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

    if (!resultText && streamedText) {
      console.log('[agent] No result message — using streamed text as fallback');
    } else if (!resultText && !streamedText) {
      console.warn('[agent] No result and no streamed text — response will be empty');
    }

    // Pre-warm next process after query completes
    if (this.lastSpawnOpts) {
      this.pool.schedulePrewarm(this.lastSpawnOpts);
    }

    return { response: resultText || streamedText, sessionId: newSessionId };
  }
}
