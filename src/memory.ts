import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import path from 'path';
import type { Config } from './types.js';

export class Memory {
  private soulContent = '';
  private memoryContent = '';
  private soulPath: string;
  private memoryPath: string;

  constructor(private config: Config) {
    this.soulPath = path.join(config.workspaceDir, 'soul.md');
    this.memoryPath = path.join(config.workspaceDir, 'memory.md');
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.soulPath), { recursive: true });
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

  private watchSoul(): void {
    if (!existsSync(this.soulPath)) return;
    try {
      fsWatch(this.soulPath, async () => {
        try { await this.reload(); } catch { /* ignore */ }
      });
    } catch { /* ignore if watch fails */ }
  }
}
