import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeShell } from '../src/tools/shell.js';
import { testConfig } from './helpers.js';

describe('executeShell allowlist', () => {
  it('runs an allowlisted command', async () => {
    const out = await executeShell('echo hello', testConfig({ shellAllowlist: ['echo'] }));
    assert.match(out, /hello/);
  });

  it('rejects a command not in the allowlist', async () => {
    const out = await executeShell('ls', testConfig({ shellAllowlist: ['echo'] }));
    assert.match(out, /not in allowlist/);
  });

  it('rejects chained commands that start with an allowlisted binary', async () => {
    for (const cmd of ['echo hi; ls', 'echo hi | cat', 'echo hi && ls', 'echo $(whoami)', 'echo `whoami`', 'echo hi > /tmp/x']) {
      const out = await executeShell(cmd, testConfig({ shellAllowlist: ['echo'] }));
      assert.match(out, /metacharacters/, `should reject: ${cmd}`);
    }
  });

  it('allows metacharacters when no allowlist is configured', async () => {
    const out = await executeShell('echo a; echo b', testConfig());
    assert.match(out, /a\nb/);
  });
});
