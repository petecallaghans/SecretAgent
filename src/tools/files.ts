import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import path from 'path';
import type { Config } from '../types.js';

const MAX_FILE_SIZE = 100_000;

function resolveSafe(baseDir: string, filePath: string): string | null {
  const resolved = path.resolve(baseDir, filePath);
  if (!resolved.startsWith(path.resolve(baseDir))) return null;
  return resolved;
}

export async function readFileContent(filePath: string, config: Config): Promise<string> {
  const resolved = resolveSafe(config.workspaceDir, filePath);
  if (!resolved) return 'Error: Path outside workspace directory.';
  try {
    const content = await readFile(resolved, 'utf-8');
    return content.length > MAX_FILE_SIZE
      ? content.slice(0, MAX_FILE_SIZE) + '\n... (truncated)'
      : content;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error reading file: ${msg}`;
  }
}

export async function writeFileContent(filePath: string, content: string, config: Config): Promise<string> {
  const resolved = resolveSafe(config.workspaceDir, filePath);
  if (!resolved) return 'Error: Path outside workspace directory.';
  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf-8');
    return `File written: ${filePath}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error writing file: ${msg}`;
  }
}

export async function listFiles(dirPath: string, config: Config): Promise<string> {
  const resolved = resolveSafe(config.workspaceDir, dirPath || '.');
  if (!resolved) return 'Error: Path outside workspace directory.';
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const lines = entries.map(e =>
      `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
    );
    return lines.join('\n') || '(empty directory)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error listing directory: ${msg}`;
  }
}
