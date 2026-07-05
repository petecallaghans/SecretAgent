import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { searchMemory } from '../src/tools/memorySearch.js';
import { testConfig } from './helpers.js';

let ws: string;

before(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'sa-mem-'));
  await mkdir(path.join(ws, 'memory', 'topics'), { recursive: true });
  await writeFile(path.join(ws, 'memory.md'), '- [Pete](memory/topics/pete.md) — user profile\n');
  await writeFile(path.join(ws, 'memory', 'topics', 'pete.md'), 'Pete lives in Sydney.\nPrefers dark mode.\n');
  await writeFile(path.join(ws, 'memory', '2026-07-04.md'), 'Discussed the Slack integration plan.\n');
});

after(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('searchMemory', () => {
  it('finds hits across index, topics, and daily logs', async () => {
    const cfg = testConfig({ workspaceDir: ws });
    const out = await searchMemory('pete', cfg);
    assert.match(out, /memory\.md:1/);
    assert.match(out, /memory\/topics\/pete\.md:1/);

    const log = await searchMemory('slack', cfg);
    assert.match(log, /memory\/2026-07-04\.md:1/);
  });

  it('reports no matches cleanly', async () => {
    const out = await searchMemory('zzz-not-there', testConfig({ workspaceDir: ws }));
    assert.match(out, /No matches/);
  });

  it('treats an invalid regex as a literal', async () => {
    const out = await searchMemory('dark mode (', testConfig({ workspaceDir: ws }));
    assert.match(out, /No matches/); // literal "dark mode (" doesn't exist — but must not throw
  });
});
