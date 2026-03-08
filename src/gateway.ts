import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import type { Config, CronJobDef, WebhookDef } from './types.js';
import type { SessionManager } from './sessions.js';
import type { Agent, StreamCallback } from './agent.js';
import type { Memory } from './memory.js';
import type { CronScheduler } from './cron.js';
import type { WebhookServer } from './webhook.js';

export const MODELS: Record<string, string> = {
  'sonnet-4-5': 'claude-sonnet-4-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'opus-4-6': 'claude-opus-4-6',
};

export const MODEL_DISPLAY: Record<string, string> = {
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-6': 'Opus 4.6',
};

export class Gateway {
  private processing = new Set<string>();
  private queues = new Map<string, Array<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    text: string;
  }>>();
  private cronScheduler?: CronScheduler;
  private webhookServer?: WebhookServer;
  private chatModels = new Map<string, string>();
  private approvalEnabled = new Map<string, boolean>();

  constructor(
    private config: Config,
    private sessions: SessionManager,
    private agent: Agent,
    private memory: Memory,
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

  async handleMessage(chatId: string, text: string, onStream?: StreamCallback): Promise<string> {
    // Queue if already processing for this session
    if (this.processing.has(chatId)) {
      return new Promise((resolve, reject) => {
        let queue = this.queues.get(chatId);
        if (!queue) {
          queue = [];
          this.queues.set(chatId, queue);
        }
        queue.push({ resolve, reject, text });
      });
    }

    this.processing.add(chatId);
    try {
      return await this.processMessage(chatId, text, onStream);
    } finally {
      this.processing.delete(chatId);
      // Process next queued message
      const queue = this.queues.get(chatId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.queues.delete(chatId);
        this.handleMessage(chatId, next.text).then(next.resolve, next.reject);
      }
    }
  }

  private async processMessage(chatId: string, text: string, onStream?: StreamCallback): Promise<string> {
    const sessionId = this.sessions.getSessionId(chatId);
    const model = this.chatModels.get(chatId);
    const { response, sessionId: newSessionId } = await this.agent.run(text, sessionId, chatId, model, onStream);
    if (newSessionId) {
      await this.sessions.setSessionId(chatId, newSessionId);
    }
    return response;
  }

  setModel(chatId: string, model: string): void {
    this.chatModels.set(chatId, model);
  }

  getModel(chatId: string): string {
    return this.chatModels.get(chatId) || this.config.model;
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
    return this.handleMessage(chatId, prompt);
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
}
