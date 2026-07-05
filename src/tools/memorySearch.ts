import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config } from '../types.js';

const MAX_HITS = 50;

interface Hit {
  file: string;
  line: number;
  context: string[];
}

/**
 * Search long-term memory: memory.md (index), topic files, and all daily logs.
 * Case-insensitive. `pattern` is tried as a regex first, falling back to a
 * literal substring match if it doesn't compile.
 */
export async function searchMemory(pattern: string, config: Config): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const files = await collectMemoryFiles(config);
  const hits: Hit[] = [];

  for (const file of files) {
    if (hits.length >= MAX_HITS) break;
    let content: string;
    try {
      content = await readFile(file.abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
      if (!re.test(lines[i])) continue;
      const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2));
      hits.push({ file: file.rel, line: i + 1, context });
    }
  }

  if (hits.length === 0) {
    return `No matches for "${pattern}" in memory, topics, or daily logs.`;
  }

  const out = hits.map(h => `${h.file}:${h.line}\n${h.context.join('\n')}`).join('\n---\n');
  const suffix = hits.length >= MAX_HITS ? `\n\n(capped at ${MAX_HITS} hits — narrow the pattern)` : '';
  return out + suffix;
}

async function collectMemoryFiles(config: Config): Promise<Array<{ abs: string; rel: string }>> {
  const files: Array<{ abs: string; rel: string }> = [];
  const ws = config.workspaceDir;

  const memoryMd = path.join(ws, 'memory.md');
  if (existsSync(memoryMd)) files.push({ abs: memoryMd, rel: 'memory.md' });

  const topicsDir = path.join(ws, 'memory', 'topics');
  if (existsSync(topicsDir)) {
    for (const name of (await readdir(topicsDir)).sort()) {
      if (name.endsWith('.md')) {
        files.push({ abs: path.join(topicsDir, name), rel: `memory/topics/${name}` });
      }
    }
  }

  const logDir = path.join(ws, 'memory');
  if (existsSync(logDir)) {
    // Newest logs first — recent context matters more when the hit cap kicks in
    for (const name of (await readdir(logDir)).sort().reverse()) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
        files.push({ abs: path.join(logDir, name), rel: `memory/${name}` });
      }
    }
  }

  return files;
}
