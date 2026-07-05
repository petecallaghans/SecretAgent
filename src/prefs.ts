import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config, Effort } from './types.js';

export interface ChatPrefs {
  model?: string;
  effort?: Effort;
}

/** Per-chat preferences (model, effort) persisted to data/prefs.json. */
export class PrefsStore {
  private prefsFile: string;
  private prefs: Record<string, ChatPrefs> = {};

  constructor(private config: Config) {
    this.prefsFile = path.join(config.dataDir, 'prefs.json');
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    if (existsSync(this.prefsFile)) {
      try {
        this.prefs = JSON.parse(await readFile(this.prefsFile, 'utf-8'));
      } catch {
        this.prefs = {};
      }
    }
  }

  get(chatId: string): ChatPrefs {
    return this.prefs[chatId] || {};
  }

  async set(chatId: string, patch: ChatPrefs): Promise<void> {
    this.prefs[chatId] = { ...this.prefs[chatId], ...patch };
    await writeFile(this.prefsFile, JSON.stringify(this.prefs, null, 2), 'utf-8');
  }
}
