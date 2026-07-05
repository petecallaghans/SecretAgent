import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import path from 'path';
import type { Config } from './types.js';

export class Memory {
  private soulContent = '';
  private memoryContent = '';
  private toolsContent = '';
  private soulPath: string;
  private memoryPath: string;
  private toolsPath: string;
  private logDir: string;
  /** Serializes all file writes so concurrent chats can't interleave read-modify-write. */
  private writeLock: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: Config) {
    this.soulPath = path.join(config.workspaceDir, 'soul.md');
    this.memoryPath = path.join(config.workspaceDir, 'memory.md');
    this.toolsPath = path.join(config.workspaceDir, 'tools.md');
    this.logDir = path.join(config.workspaceDir, 'memory');
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.soulPath), { recursive: true });
    await mkdir(this.logDir, { recursive: true });
    await this.reload();
    this.watchWorkspace();
  }

  /** Run fn while holding the write lock. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeLock.then(fn);
    this.writeLock = result.then(() => undefined, () => undefined);
    return result;
  }

  async reload(): Promise<void> {
    this.soulContent = existsSync(this.soulPath)
      ? await readFile(this.soulPath, 'utf-8')
      : '';
    this.memoryContent = existsSync(this.memoryPath)
      ? await readFile(this.memoryPath, 'utf-8')
      : '';
    this.toolsContent = existsSync(this.toolsPath)
      ? await readFile(this.toolsPath, 'utf-8')
      : '';
  }

  getSoul(): string {
    return this.soulContent;
  }

  getMemory(): string {
    return this.memoryContent;
  }

  getTools(): string {
    return this.toolsContent;
  }

  async saveMemory(content: string): Promise<void> {
    await this.withLock(async () => {
      this.memoryContent = content;
      await writeFile(this.memoryPath, content, 'utf-8');
    });
  }

  async appendMemory(content: string): Promise<void> {
    await this.withLock(async () => {
      // Re-read from disk — another writer (or a hand edit) may have changed it
      const current = existsSync(this.memoryPath)
        ? await readFile(this.memoryPath, 'utf-8')
        : '';
      this.memoryContent = current ? current + '\n' + content : content;
      await writeFile(this.memoryPath, this.memoryContent, 'utf-8');
    });
  }

  async saveSoul(content: string): Promise<void> {
    await this.withLock(async () => {
      this.soulContent = content;
      await writeFile(this.soulPath, content, 'utf-8');
    });
  }

  async getLog(date: string): Promise<string> {
    const logPath = path.join(this.logDir, `${date}.md`);
    return existsSync(logPath) ? await readFile(logPath, 'utf-8') : '';
  }

  async appendLog(content: string, date?: string): Promise<void> {
    await this.withLock(async () => {
      const d = date || new Date().toISOString().slice(0, 10);
      const logPath = path.join(this.logDir, `${d}.md`);
      const existing = existsSync(logPath) ? await readFile(logPath, 'utf-8') : '';
      await writeFile(logPath, existing ? existing + '\n' + content : content, 'utf-8');
    });
  }

  async getRecentLogs(): Promise<string> {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const todayStr = today.toISOString().slice(0, 10);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const todayLog = await this.getLog(todayStr);
    const yesterdayLog = await this.getLog(yesterdayStr);

    const parts: string[] = [];
    if (todayLog) parts.push(`### ${todayStr}\n${todayLog}`);
    if (yesterdayLog) parts.push(`### ${yesterdayStr}\n${yesterdayLog}`);
    return parts.join('\n\n');
  }

  /**
   * Watch the workspace directory (not individual files — editors that replace
   * files by inode swap would kill a per-file watcher) and reload soul/memory/tools
   * on change, debounced.
   */
  private watchWorkspace(): void {
    const watched = new Set(['soul.md', 'memory.md', 'tools.md']);
    try {
      fsWatch(this.config.workspaceDir, (_event, filename) => {
        if (!filename || !watched.has(filename)) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reload().catch(() => { /* ignore */ });
        }, 250);
      });
    } catch { /* ignore if watch fails */ }
  }
}
