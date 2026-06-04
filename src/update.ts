import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const exec = promisify(execCb);

/** Files in tracked dirs that the user customizes — preserved across update. */
const PRESERVED_FILES = [
  'workspace/soul.md',
  'workspace/memory.md',
  'workspace/tools.md',
  'workspace/mcp.json',
  'workspace/roster.json',
];

export interface UpdateResult {
  status: 'updated' | 'up-to-date' | 'failed';
  before: string;
  after: string;
  message: string;
}

export type ProgressFn = (msg: string) => void;

async function run(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Pull the latest version from git, preserving the user's soul/memory/tools/mcp customizations
 * and any uncommitted code changes (stashed for recovery). Caller decides whether to restart.
 */
export async function runUpdate(report: ProgressFn): Promise<UpdateResult> {
  const cwd = process.cwd();
  const fail = (message: string, before = '', after = ''): UpdateResult =>
    ({ status: 'failed', before, after, message });

  // Verify we're in a git repo
  try {
    await run('git rev-parse --is-inside-work-tree', cwd);
  } catch {
    return fail('Not a git checkout — cannot self-update.');
  }

  let before = '';
  try {
    before = (await run('git rev-parse --short HEAD', cwd)).stdout.trim();
  } catch (err) {
    return fail(`Could not read current version: ${(err as Error).message}`);
  }

  // 1. Snapshot the user's personal files
  const snapshot = new Map<string, string>();
  for (const rel of PRESERVED_FILES) {
    const abs = path.join(cwd, rel);
    if (existsSync(abs)) {
      snapshot.set(rel, await readFile(abs, 'utf-8'));
    }
  }
  report(`Saved ${snapshot.size} personal file(s).`);

  // 2. Fetch latest
  report('Checking for updates...');
  try {
    await run('git fetch origin', cwd);
  } catch (err) {
    return fail(`Could not fetch updates: ${(err as Error).message}`, before, before);
  }

  // 3. Determine branch + how far behind
  let branch = '';
  try {
    branch = (await run('git rev-parse --abbrev-ref HEAD', cwd)).stdout.trim();
    if (branch === 'HEAD') {
      return fail('Repo is in detached HEAD — cannot auto-update.', before, before);
    }
  } catch (err) {
    return fail(`Could not read branch: ${(err as Error).message}`, before, before);
  }

  let behind = 0;
  let ahead = 0;
  try {
    const { stdout } = await run(`git rev-list --left-right --count HEAD...origin/${branch}`, cwd);
    [ahead, behind] = stdout.trim().split(/\s+/).map(Number) as [number, number];
  } catch (err) {
    return fail(`Could not compare with remote: ${(err as Error).message}`, before, before);
  }

  if (behind === 0) {
    return { status: 'up-to-date', before, after: before, message: `Already up to date (${before}).` };
  }
  report(`${behind} new change(s) available.${ahead > 0 ? ` (You have ${ahead} local commit(s) — they will be stashed.)` : ''}`);

  // 4. Stash any local edits (recoverable later via `git stash list`)
  try {
    const { stdout: status } = await run('git status --porcelain', cwd);
    if (status.trim().length > 0) {
      const stamp = new Date().toISOString();
      await run(`git stash push -u -m "secret-agent /update ${stamp}"`, cwd);
      report('Stashed local changes (recover with: git stash list).');
    }
  } catch (err) {
    return fail(`Could not stash local changes: ${(err as Error).message}`, before, before);
  }

  // 5. Hard reset to upstream
  try {
    await run(`git reset --hard origin/${branch}`, cwd);
  } catch (err) {
    return fail(`Could not apply update: ${(err as Error).message}`, before, before);
  }
  const after = (await run('git rev-parse --short HEAD', cwd)).stdout.trim();
  report(`Pulled ${before} → ${after}.`);

  // 6. Restore the user's personal files (overrides any upstream changes to those paths)
  for (const [rel, content] of snapshot) {
    await writeFile(path.join(cwd, rel), content, 'utf-8');
  }
  if (snapshot.size > 0) report('Restored personal files.');

  // 7. Install dependencies
  report('Installing dependencies...');
  try {
    await run('npm install --silent', cwd);
  } catch (err) {
    return fail(`Dependency install failed: ${(err as Error).message}`, before, after);
  }

  // 8. Build
  report('Building...');
  try {
    await run('npm run build', cwd);
  } catch (err) {
    return fail(`Build failed: ${(err as Error).message}`, before, after);
  }

  return {
    status: 'updated',
    before,
    after,
    message: `Updated ${before} → ${after}.`,
  };
}
