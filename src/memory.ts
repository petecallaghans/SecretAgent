import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import path from 'path';
import type { Config } from './types.js';

export class Memory {
  private soulContent = '';
  private memoryContent = '';
  private soulPath: string;
  private memoryPath: string;
  private logDir: string;

  constructor(private config: Config) {
    this.soulPath = path.join(config.workspaceDir, 'soul.md');
    this.memoryPath = path.join(config.workspaceDir, 'memory.md');
    this.logDir = path.join(config.workspaceDir, 'memory');
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.soulPath), { recursive: true });
    await mkdir(this.logDir, { recursive: true });
    await this.reload();
    this.watchSoul();
  }

  async reload(): Promise<void> {
    this.soulContent = existsSync(this.soulPath)
      ? await readFile(this.soulPath, 'utf-8')
      : '';
    this.memoryContent = existsSync(this.memoryPath)
      ? await readFile(this.memoryPath, 'utf-8')
      : '';
  }

  getSoul(): string {
    return this.soulContent;
  }

  getMemory(): string {
    return this.memoryContent;
  }

  async saveMemory(content: string): Promise<void> {
    this.memoryContent = content;
    await writeFile(this.memoryPath, content, 'utf-8');
  }

  async appendMemory(content: string): Promise<void> {
    this.memoryContent += '\n' + content;
    await writeFile(this.memoryPath, this.memoryContent, 'utf-8');
  }

  async saveSoul(content: string): Promise<void> {
    this.soulContent = content;
    await writeFile(this.soulPath, content, 'utf-8');
  }

  async getLog(date: string): Promise<string> {
    const logPath = path.join(this.logDir, `${date}.md`);
    return existsSync(logPath) ? await readFile(logPath, 'utf-8') : '';
  }

  async appendLog(content: string, date?: string): Promise<void> {
    const d = date || new Date().toISOString().slice(0, 10);
    const logPath = path.join(this.logDir, `${d}.md`);
    const existing = existsSync(logPath) ? await readFile(logPath, 'utf-8') : '';
    await writeFile(logPath, existing ? existing + '\n' + content : content, 'utf-8');
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

  private watchSoul(): void {
    if (!existsSync(this.soulPath)) return;
    try {
      fsWatch(this.soulPath, async () => {
        try { await this.reload(); } catch { /* ignore */ }
      });
    } catch { /* ignore if watch fails */ }
  }
}
