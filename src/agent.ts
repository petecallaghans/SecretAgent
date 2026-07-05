import { query, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import type { Config, AgentState, PeerContext } from './types.js';
import type { Memory } from './memory.js';
import type { Roster } from './roster.js';

const SERVER_NAME = 'secret-agent-tools';

/** Scale maxTurns by effort — a workhorse needs room; cost is governed by model tier + subagents */
const EFFORT_MAX_TURNS: Record<string, number> = {
  low: 8,
  medium: 15,
  high: 25,
  max: 40,
};

/** Scale maxTokens by effort — shorter responses for simple exchanges */
const EFFORT_MAX_TOKENS: Record<string, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16384,
};

/**
 * Native SDK subagents (invoked via the Task/Agent tool). Run on Haiku with a
 * narrow tool set: grunt work happens in cheap throwaway contexts while the
 * main session stays small. Auth rides the same OAuth as the main agent.
 */
const SUBAGENTS = {
  researcher: {
    description:
      'Research assistant for web lookups. Use for: fetching and distilling web pages, ' +
      'web searches, checking facts online, mining long-term memory/logs. Give it a specific ' +
      'question; it returns a dense summary so the main conversation stays small.',
    prompt:
      'You are a research subagent. Use web_search, fetch_url, and memory_search to answer ' +
      'the question you were given. Be thorough but return ONLY a dense, factual summary ' +
      'with sources — no preamble, no filler. If you cannot find an answer, say exactly what you tried.',
    tools: [
      `mcp__${SERVER_NAME}__web_search`,
      `mcp__${SERVER_NAME}__fetch_url`,
      `mcp__${SERVER_NAME}__memory_search`,
      'Read',
    ],
    model: 'haiku' as const,
  },
  worker: {
    description:
      'Worker for mechanical multi-step chores: running shell commands, reading/writing ' +
      'workspace files, batch file operations. Give it a concrete task; it reports the outcome.',
    prompt:
      'You are a worker subagent. Execute the task you were given using shell and file tools. ' +
      'Work step by step, verify results, and report ONLY the outcome: what was done, what ' +
      'succeeded, what failed (with the exact error). No preamble.',
    tools: [
      `mcp__${SERVER_NAME}__shell`,
      `mcp__${SERVER_NAME}__read_file`,
      `mcp__${SERVER_NAME}__write_file`,
      `mcp__${SERVER_NAME}__list_files`,
      'Read',
    ],
    model: 'haiku' as const,
  },
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
  private warm: { process: ReturnType<typeof spawn>; opts: SpawnOptions } | null = null;

  private optsMatch(a: SpawnOptions, b: SpawnOptions): boolean {
    if (a.command !== b.command) return false;
    if (a.cwd !== b.cwd) return false;
    if (a.args.length !== b.args.length) return false;
    for (let i = 0; i < a.args.length; i++) {
      if (a.args[i] !== b.args[i]) return false;
    }
    const aEnv = (a.env || {}) as Record<string, string | undefined>;
    const bEnv = (b.env || {}) as Record<string, string | undefined>;
    const aKeys = Object.keys(aEnv);
    const bKeys = Object.keys(bEnv);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (aEnv[k] !== bEnv[k]) return false;
    }
    return true;
  }

  prewarm(opts: SpawnOptions): void {
    if (this.warm) return;
    try {
      const child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.warm = { process: child, opts };
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

  acquire(opts: SpawnOptions): SpawnedProcess {
    if (this.warm && this.optsMatch(this.warm.opts, opts)) {
      console.log('[pool] Reusing pre-warmed process');
      const child = this.warm.process;
      this.warm = null;
      return child as unknown as SpawnedProcess;
    }

    if (this.warm) {
      console.log('[pool] Discarding stale pre-warmed process (opts changed)');
      this.warm.process.kill('SIGTERM');
      this.warm = null;
    }

    console.log('[pool] Cold spawn');
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child as unknown as SpawnedProcess;
  }

  schedulePrewarm(opts: SpawnOptions): void {
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
    private state: AgentState,
    private roster: Roster | null = null,
  ) {}

  dispose(): void {
    this.pool.dispose();
  }

  private async buildSystemPrompt(): Promise<string> {
    const now = Date.now();
    // Cache system prompt for 30s — avoids re-reading log files every message
    if (this.cachedSystemPrompt && now < this.systemPromptExpiry) {
      return this.cachedSystemPrompt;
    }

    const parts: string[] = [];

    const soul = this.memory.getSoul();
    if (soul) parts.push(soul);

    if (this.roster) parts.push(`\n${this.roster.describe()}`);

    const tools = this.memory.getTools();
    if (tools) parts.push(`\n## Tools & Instructions\nIMPORTANT: Follow these instructions carefully — they define your available tools and behavioral rules.\n${tools}`);

    const mem = this.memory.getMemory();
    if (mem) parts.push(`\n## Long-term Memory (index)\n${mem}`);

    parts.push([
      '\n## Subagents',
      'You have two cheap subagents (launched via the Task tool): `researcher` (web search, ' +
        'URL fetching, memory mining) and `worker` (shell + file chores). Prefer them for ' +
        'research and mechanical multi-step work — they keep this conversation small and cheap. ' +
        'Handle reasoning, judgment, and user-facing answers yourself.',
    ].join('\n'));

    parts.push([
      '\n## Memory protocol',
      '- memory.md above is an INDEX: one line per topic pointing at memory/topics/<slug>.md.',
      '- Details live in topic files — read them with read_file when a topic is relevant.',
      '- Before saying you don\'t know or don\'t remember something, use memory_search.',
      '- New durable facts: write/update a topic file, then keep the index line current.',
      '- Conversation events and observations go to append_log, not memory.',
    ].join('\n'));

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
    peerCtx?: PeerContext,
    effortOverride?: string,
  ): Promise<{ response: string; sessionId: string }> {
    // Set chatId and peer context together so tools see a consistent view for this run.
    this.state.chatId = chatId;
    this.state.peer = peerCtx;

    let resultText = '';
    let streamedText = '';
    let newSessionId = sessionId || '';

    const externalServers = await this.loadExternalMcpServers();
    // 'Task'/'Agent' = subagent launcher (name varies across SDK versions)
    const allowedTools: string[] = [`mcp__${SERVER_NAME}__*`, 'Read', 'Task', 'Agent'];
    const mcpServers: Record<string, unknown> = { [SERVER_NAME]: this.toolServer };

    for (const [name, serverConfig] of Object.entries(externalServers)) {
      allowedTools.push(`mcp__${name}__*`);
      mcpServers[name] = serverConfig;
    }

    // Build thinking config from settings
    const thinking = this.config.thinking === 'disabled'
      ? { type: 'disabled' as const }
      : { type: 'adaptive' as const };

    const effort = effortOverride || this.config.effort;
    const maxTurns = EFFORT_MAX_TURNS[effort] ?? 10;
    const maxTokens = Math.min(
      EFFORT_MAX_TOKENS[effort] ?? 4096,
      this.config.maxTokens,
    );

    const options: Record<string, unknown> = {
      systemPrompt: await this.buildSystemPrompt(),
      model: model || this.config.modelDefault,
      maxTurns,
      maxTokens,
      allowedTools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      mcpServers,
      agents: SUBAGENTS,
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
