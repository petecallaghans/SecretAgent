import { exec } from 'child_process';
import type { Config } from '../types.js';

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 10_000;

export async function executeShell(command: string, config: Config): Promise<string> {
  if (config.shellAllowlist.length > 0) {
    const cmd = command.trim().split(/\s+/)[0];
    if (!config.shellAllowlist.includes(cmd)) {
      return `Error: Command '${cmd}' not in allowlist. Allowed: ${config.shellAllowlist.join(', ')}`;
    }
  }

  // Ensure ~/.local/bin is on PATH for user-installed tools
  const env = { ...process.env };
  const localBin = `${process.env.HOME || '/root'}/.local/bin`;
  env.PATH = env.PATH ? `${localBin}:${env.PATH}` : localBin;

  return new Promise((resolve) => {
    exec(command, {
      timeout: DEFAULT_TIMEOUT,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash',
      env,
    }, (error, stdout, stderr) => {
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n' : '') + `stderr: ${stderr}`;
      if (error && !stdout && !stderr) output = `Error: ${error.message}`;
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
      }
      resolve(output || '(no output)');
    });
  });
}
