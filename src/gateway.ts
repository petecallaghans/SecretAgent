import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Config, CronJobDef } from './types.js';
import type { SessionManager } from './sessions.js';
import type { Agent } from './agent.js';
import type { Memory } from './memory.js';
import type { CronScheduler } from './cron.js';

export class Gateway {
  private processing = new Set<string>();
  private queues = new Map<string, Array<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    text: string;
  }>>();
  private cronScheduler?: CronScheduler;

  constructor(
    private config: Config,
    private sessions: SessionManager,
    private agent: Agent,
    private memory: Memory,
  ) {}

  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler;
  }

  async handleMessage(chatId: string, text: string): Promise<string> {
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
      return await this.processMessage(chatId, text);
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

  private async processMessage(chatId: string, text: string): Promise<string> {
    const sessionId = this.sessions.getSessionId(chatId);
    const { response, sessionId: newSessionId } = await this.agent.run(text, sessionId, chatId);
    if (newSessionId) {
      await this.sessions.setSessionId(chatId, newSessionId);
    }
    return response;
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
}
