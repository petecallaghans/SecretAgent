import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import type { Config, CronJobDef, WebhookDef, PeerContext, PeerMessage } from './types.js';
import type { SessionManager } from './sessions.js';
import type { Agent, StreamCallback } from './agent.js';
import type { Memory } from './memory.js';
import type { CronScheduler } from './cron.js';
import type { WebhookServer } from './webhook.js';
import type { Roster } from './roster.js';
import type { PrefsStore } from './prefs.js';

import type { Effort, ThinkingMode } from './types.js';

export type MessageSource = 'user' | 'cron' | 'webhook' | 'voice' | 'peer' | 'system';

/** One-shot maintenance turn asked of the agent when a session hits the rotation cap. */
const ROTATION_PROMPT =
  'System: this conversation is being rotated to keep context small. ' +
  'Append ONE compact entry to today\'s daily log (append_log) capturing: durable facts learned, ' +
  'decisions made, and any unfinished work with its current state. If a durable fact belongs in ' +
  'long-term memory, update the relevant topic file too. Then reply "OK".';

export const MODELS: Record<string, string> = {
  'haiku-4-5': 'claude-haiku-4-5',
  'sonnet-4-5': 'claude-sonnet-4-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'sonnet-5': 'claude-sonnet-5',
  'opus-4-6': 'claude-opus-4-6',
  'opus-4-8': 'claude-opus-4-8',
};

export const MODEL_DISPLAY: Record<string, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-8': 'Opus 4.8',
};

export const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'max'];

/** Strip leading /deep or /light prefix from user text. */
export function stripPrefix(message: string): string {
  return message.replace(/^\/(deep|light)(\s+|$)/, '');
}

export class Gateway {
  private processing = new Set<string>();
  private queues = new Map<string, Array<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    text: string;
    onStream?: StreamCallback;
    source: MessageSource;
    sessionKey?: string;
    peerCtx?: PeerContext;
  }>>();
  private cronScheduler?: CronScheduler;
  private webhookServer?: WebhookServer;
  private approvalEnabled = new Map<string, boolean>();

  constructor(
    private config: Config,
    private sessions: SessionManager,
    private agent: Agent,
    private memory: Memory,
    private roster: Roster | null = null,
    private prefs: PrefsStore | null = null,
  ) {}

  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  setWebhookServer(server: WebhookServer): void {
    this.webhookServer = server;
  }

  toggleApproval(chatId: string): boolean {
    const current = this.approvalEnabled.get(chatId) ?? false;
    this.approvalEnabled.set(chatId, !current);
    return !current;
  }

  getApproval(chatId: string): boolean {
    return this.approvalEnabled.get(chatId) ?? false;
  }

  async handleMessage(
    chatId: string,
    text: string,
    onStream?: StreamCallback,
    source: MessageSource = 'user',
    sessionKey?: string,
    peerCtx?: PeerContext,
  ): Promise<string> {
    if (this.processing.has(chatId)) {
      return new Promise((resolve, reject) => {
        let queue = this.queues.get(chatId);
        if (!queue) {
          queue = [];
          this.queues.set(chatId, queue);
        }
        queue.push({ resolve, reject, text, onStream, source, sessionKey, peerCtx });
      });
    }

    this.processing.add(chatId);
    try {
      return await this.processMessage(chatId, text, source, onStream, sessionKey, peerCtx);
    } finally {
      this.processing.delete(chatId);
      const queue = this.queues.get(chatId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.queues.delete(chatId);
        this.handleMessage(chatId, next.text, next.onStream, next.source, next.sessionKey, next.peerCtx)
          .then(next.resolve, next.reject);
      }
    }
  }

  private async processMessage(
    chatId: string,
    text: string,
    source: MessageSource,
    onStream?: StreamCallback,
    sessionKey?: string,
    peerCtx?: PeerContext,
  ): Promise<string> {
    // Peer-triggered runs are scoped to a per-conversation session key so unrelated
    // chains don't bleed into one another; everything else keys on chatId.
    const key = sessionKey ?? chatId;
    const sessionId = this.sessions.getSessionId(key);
    const model = this.selectModel(chatId, text, source);
    const effort = this.selectEffort(chatId, text, source);
    const cleanText = source === 'user' ? stripPrefix(text) : text;
    const { response, sessionId: newSessionId } = await this.agent.run(
      cleanText, sessionId, chatId, model, onStream, peerCtx, effort,
    );

    if (source === 'system') {
      // Maintenance turns (rotation wrap-up, nightly distill) end their session:
      // the next real message starts fresh with memory intact.
      await this.sessions.clearSession(key);
      return response;
    }

    if (newSessionId) {
      await this.sessions.setSessionId(key, newSessionId);
    }

    // Session rotation: past the cap, queue a wrap-up turn behind this one.
    // It summarizes to the daily log, then (as source 'system') clears the session.
    if (
      source === 'user' &&
      this.config.sessionMaxMessages > 0 &&
      this.sessions.getCount(key) >= this.config.sessionMaxMessages
    ) {
      console.log(`[gateway] Session ${key} hit ${this.sessions.getCount(key)} messages — rotating`);
      this.handleMessage(chatId, ROTATION_PROMPT, undefined, 'system', key).catch(err => {
        console.error('[gateway] rotation wrap-up failed:', err);
        // Still rotate — a stuck giant session is worse than a lost summary
        void this.sessions.clearSession(key);
      });
    }

    return response;
  }

  /**
   * Handle an inbound peer message: frame it with the sender's identity, route it
   * through the queue under a chain-scoped session, and return the agent's reply.
   * The reply is posted to the group by the caller (humans watch there).
   */
  async handlePeerMessage(env: PeerMessage): Promise<string> {
    if (!this.roster) throw new Error('Received a peer message but no roster is configured.');
    const sender = this.roster.resolvePeer(env.from);
    const senderLabel = sender ? `${sender.name} (${sender.role})` : env.from;

    let framed = `Message from teammate ${senderLabel} [peer]:\n${env.message}`;
    if (env.payload !== undefined) {
      framed += `\n\nStructured payload:\n${JSON.stringify(env.payload, null, 2)}`;
    }

    const peerCtx: PeerContext = { chainId: env.chainId, hops: env.hops, replyTo: env.msgId };
    const groupChatId = this.roster.groupChatId;
    return this.handleMessage(groupChatId, framed, undefined, 'peer', `peer:${env.chainId}`, peerCtx);
  }

  /**
   * Route a message to the appropriate model tier.
   *   1. User /deep or /light prefix → deep/light override (single message).
   *   2. cron/webhook → light (background relay work).
   *   3. Per-chat session default set via /model. Voice is real user input,
   *      so transcripts get the same model as typed messages.
   *   4. config.modelDefault.
   */
  selectModel(chatId: string, message: string, source: MessageSource): string {
    if (source === 'user') {
      if (/^\/deep(\s|$)/.test(message)) return this.config.modelDeep;
      if (/^\/light(\s|$)/.test(message)) return this.config.modelLight;
    }
    if (source === 'cron' || source === 'webhook' || source === 'system') {
      return this.config.modelLight;
    }
    return this.prefs?.get(chatId).model || this.config.modelDefault;
  }

  /**
   * Effort per message: /deep bumps to high for that message; otherwise the
   * per-chat preference, falling back to the config default. Background
   * sources (cron/webhook/system) stay at the config default.
   */
  selectEffort(chatId: string, message: string, source: MessageSource): Effort {
    if (source === 'user' && /^\/deep(\s|$)/.test(message)) return 'high';
    if (source === 'user' || source === 'voice') {
      return this.prefs?.get(chatId).effort || this.config.effort;
    }
    return this.config.effort;
  }

  async setModel(chatId: string, model: string): Promise<void> {
    await this.prefs?.set(chatId, { model });
  }

  getModel(chatId: string): string {
    return this.prefs?.get(chatId).model || this.config.modelDefault;
  }

  async setEffort(chatId: string, effort: Effort): Promise<void> {
    await this.prefs?.set(chatId, { effort });
  }

  getEffort(chatId: string): Effort {
    return this.prefs?.get(chatId).effort || this.config.effort;
  }

  setThinking(mode: ThinkingMode): void {
    this.config.thinking = mode;
  }

  getThinking(): ThinkingMode {
    return this.config.thinking;
  }

  async handleVoice(chatId: string, oggBuffer: Buffer, caption?: string): Promise<string> {
    if (!this.config.openaiApiKey) {
      return 'Voice notes require OPENAI_API_KEY to be set.';
    }
    const openai = new OpenAI({ apiKey: this.config.openaiApiKey });
    const file = new File([new Uint8Array(oggBuffer)], 'voice.ogg', { type: 'audio/ogg' });
    const { text: transcript } = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });
    const prompt = caption
      ? `[Voice transcript] ${transcript}\n\n${caption}`
      : `[Voice transcript] ${transcript}`;
    return this.handleMessage(chatId, prompt, undefined, 'voice');
  }

  async handleImage(chatId: string, base64: string, caption: string): Promise<string> {
    // Save image to workspace tmp dir so the agent can Read it
    const tmpDir = path.join(this.config.workspaceDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const filename = `image_${Date.now()}.jpg`;
    const imagePath = path.resolve(tmpDir, filename);
    await writeFile(imagePath, Buffer.from(base64, 'base64'));

    const prompt = `The user sent an image saved at ${imagePath}. Use the Read tool to view it. ${caption}`;
    return this.handleMessage(chatId, prompt);
  }

  async resetSession(chatId: string): Promise<void> {
    await this.sessions.clearSession(chatId);
  }

  getMemory(): string {
    return this.memory.getMemory();
  }

  listCrons(): CronJobDef[] {
    return this.cronScheduler?.list() || [];
  }

  listWebhooks(): WebhookDef[] {
    return this.webhookServer?.list() || [];
  }

  /**
   * Wait for all in-flight and queued messages across all chats to finish.
   * Times out after `timeoutMs` to avoid hanging shutdown forever.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.processing.size > 0 || this.queues.size > 0) {
      if (Date.now() - start > timeoutMs) {
        console.warn(`[gateway] drain timed out after ${timeoutMs}ms (still processing ${this.processing.size}, queued ${this.queues.size})`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
