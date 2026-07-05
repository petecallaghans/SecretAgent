import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { WebhookServer } from '../src/webhook.js';
import { testConfig } from './helpers.js';

const PORT = 39471;
const SECRET = 'test-secret';
let server: WebhookServer;
let dataDir: string;
const fired: string[] = [];

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'sa-wh-'));
  server = new WebhookServer(testConfig({ dataDir, webhookPort: PORT }));
  server.setFireHandler(async (_wh, prompt) => { fired.push(prompt); });
  await server.init();
  await server.create('/signed', 'payload: {{payload}}', 1, SECRET);
});

after(async () => {
  server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

async function post(sig: string | undefined, body = '{"a":1}'): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${PORT}/signed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sig ? { 'x-signature-256': sig } : {}),
    },
    body,
  });
  return res.status;
}

describe('WebhookServer signature verification', () => {
  it('rejects a wrong-length signature without crashing', async () => {
    // Pre-fix this threw in timingSafeEqual and killed the process
    assert.equal(await post('sha256=tooshort'), 403);
    // Server must still be alive for the next request
    assert.equal(await post(undefined), 401);
  });

  it('rejects a wrong same-length signature', async () => {
    const bad = 'sha256=' + 'ab'.repeat(32);
    assert.equal(await post(bad), 403);
  });

  it('accepts a valid signature and fires the webhook', async () => {
    const body = '{"a":1}';
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(await post(sig, body), 200);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(fired.some(p => p.includes('{"a":1}')));
  });
});
