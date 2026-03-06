import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config, CronJobDef } from './types.js';

export class CronScheduler {
  private jobs = new Map<string, { def: CronJobDef; task: cron.ScheduledTask }>();
  private cronFile: string;
  private onFire?: (job: CronJobDef) => Promise<void>;

  constructor(private config: Config) {
    this.cronFile = path.join(config.dataDir, 'crons.json');
  }

  setFireHandler(handler: (job: CronJobDef) => Promise<void>): void {
    this.onFire = handler;
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    const defs = await this.loadDefs();
    for (const def of defs) {
      if (def.enabled) this.scheduleJob(def);
    }
    if (defs.length > 0) {
      console.log(`Restored ${defs.length} cron job(s)`);
    }
  }

  async create(schedule: string, prompt: string, chatId: number): Promise<CronJobDef> {
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron schedule: ${schedule}`);
    }
    const id = `cron_${Date.now().toString(36)}`;
    const def: CronJobDef = { id, schedule, prompt, chatId, enabled: true };
    this.scheduleJob(def);
    await this.saveDefs();
    return def;
  }

  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.task.stop();
    this.jobs.delete(id);
    await this.saveDefs();
    return true;
  }

  list(): CronJobDef[] {
    return Array.from(this.jobs.values()).map(j => j.def);
  }

  async handleToolAction(action: string, input: Record<string, unknown>): Promise<string> {
    switch (action) {
      case 'create': {
        if (!input.schedule || !input.prompt) {
          return 'Error: schedule and prompt are required for create.';
        }
        const def = await this.create(
          input.schedule as string,
          input.prompt as string,
          (input.chatId as number) || 0,
        );
        return `Created cron job: ${def.id} (${def.schedule}) - "${def.prompt}"`;
      }
      case 'list': {
        const jobs = this.list();
        if (jobs.length === 0) return 'No cron jobs configured.';
        return jobs.map(j =>
          `${j.id}: "${j.schedule}" - ${j.prompt} (${j.enabled ? 'active' : 'paused'})`
        ).join('\n');
      }
      case 'delete': {
        if (!input.id) return 'Error: id is required for delete.';
        const deleted = await this.delete(input.id as string);
        return deleted ? `Deleted cron job: ${input.id}` : `Cron job not found: ${input.id}`;
      }
      default:
        return `Unknown cron action: ${action}`;
    }
  }

  private scheduleJob(def: CronJobDef): void {
    const task = cron.schedule(def.schedule, async () => {
      if (this.onFire) {
        try {
          await this.onFire(def);
        } catch (err) {
          console.error(`Cron ${def.id} error:`, err);
        }
      }
    });
    this.jobs.set(def.id, { def, task });
  }

  private async loadDefs(): Promise<CronJobDef[]> {
    if (!existsSync(this.cronFile)) return [];
    try {
      const content = await readFile(this.cronFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  private async saveDefs(): Promise<void> {
    const defs = Array.from(this.jobs.values()).map(j => j.def);
    await writeFile(this.cronFile, JSON.stringify(defs, null, 2), 'utf-8');
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
  }
}
