import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config } from './types.js';

export class SessionManager {
  private sessionsFile: string;
  private sessions: Record<string, string> = {};

  constructor(private config: Config) {
    this.sessionsFile = path.join(config.dataDir, 'sessions.json');
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    if (existsSync(this.sessionsFile)) {
      try {
        const content = await readFile(this.sessionsFile, 'utf-8');
        this.sessions = JSON.parse(content);
      } catch {
        this.sessions = {};
      }
    }
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions[chatId];
  }

  async setSessionId(chatId: string, sessionId: string): Promise<void> {
    this.sessions[chatId] = sessionId;
    await this.save();
  }

  async clearSession(chatId: string): Promise<void> {
    delete this.sessions[chatId];
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFile(this.sessionsFile, JSON.stringify(this.sessions, null, 2), 'utf-8');
  }
}
