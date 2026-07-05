import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config } from './types.js';

interface SessionEntry {
  sessionId: string;
  /** Number of exchanges recorded in this session — drives rotation. */
  count: number;
}

export class SessionManager {
  private sessionsFile: string;
  private sessions: Record<string, SessionEntry> = {};

  constructor(private config: Config) {
    this.sessionsFile = path.join(config.dataDir, 'sessions.json');
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    if (existsSync(this.sessionsFile)) {
      try {
        const content = await readFile(this.sessionsFile, 'utf-8');
        const raw = JSON.parse(content) as Record<string, string | SessionEntry>;
        // Backward compat: old format stored a plain sessionId string per key
        for (const [key, value] of Object.entries(raw)) {
          this.sessions[key] = typeof value === 'string'
            ? { sessionId: value, count: 0 }
            : value;
        }
      } catch {
        this.sessions = {};
      }
    }
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions[chatId]?.sessionId;
  }

  getCount(chatId: string): number {
    return this.sessions[chatId]?.count ?? 0;
  }

  async setSessionId(chatId: string, sessionId: string): Promise<void> {
    const prev = this.sessions[chatId];
    this.sessions[chatId] = { sessionId, count: (prev?.count ?? 0) + 1 };
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
