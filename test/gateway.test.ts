import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import type { Config } from '../src/types.js';

const config: Config = {
  telegramBotToken: 'x',
  allowedUsers: [],
  model: 'claude-sonnet-4-5',
  maxTokens: 8192,
  workspaceDir: './workspace',
  dataDir: './data',
  shellAllowlist: [],
  webhookPort: 3000,
  openaiApiKey: '',
  effort: 'low',
  thinking: 'disabled',
};

class FakeAgent {
  delays: number[] = [];
  calls: string[] = [];
  async run(prompt: string, sessionId: string | undefined, _chatId: string, _model?: string) {
    this.calls.push(prompt);
    const delay = this.delays.shift() ?? 10;
    await new Promise(r => setTimeout(r, delay));
    return { response: `re:${prompt}`, sessionId: sessionId || 's1' };
  }
}

class FakeSessions {
  map = new Map<string, string>();
  getSessionId(chatId: string) { return this.map.get(chatId); }
  async setSessionId(chatId: string, id: string) { this.map.set(chatId, id); }
  async clearSession(chatId: string) { this.map.delete(chatId); }
}

class FakeMemory {
  getMemory() { return ''; }
}

describe('Gateway', () => {
  it('serializes messages for the same chat', async () => {
    const agent = new FakeAgent();
    agent.delays = [50, 10, 10];
    const gw = new Gateway(config, new FakeSessions() as any, agent as any, new FakeMemory() as any);

    const order: string[] = [];
    const p1 = gw.handleMessage('chat1', 'A').then(r => order.push(r));
    const p2 = gw.handleMessage('chat1', 'B').then(r => order.push(r));
    const p3 = gw.handleMessage('chat1', 'C').then(r => order.push(r));
    await Promise.all([p1, p2, p3]);

    assert.deepEqual(agent.calls, ['A', 'B', 'C']);
    assert.deepEqual(order, ['re:A', 're:B', 're:C']);
  });

  it('runs different chats concurrently', async () => {
    const agent = new FakeAgent();
    agent.delays = [50, 10];
    const gw = new Gateway(config, new FakeSessions() as any, agent as any, new FakeMemory() as any);

    const start = Date.now();
    await Promise.all([
      gw.handleMessage('chat1', 'A'),
      gw.handleMessage('chat2', 'B'),
    ]);
    const elapsed = Date.now() - start;
    // If serialized would be ~60ms; concurrent should be ~50ms
    assert.ok(elapsed < 90, `expected concurrent run, got ${elapsed}ms`);
  });

  it('preserves onStream callback for queued messages', async () => {
    const agent = new (class extends FakeAgent {
      async run(prompt: string, sessionId: string | undefined, _chatId: string, _model?: string, onStream?: (s: string) => void) {
        this.calls.push(prompt);
        if (onStream) onStream(`stream:${prompt}`);
        await new Promise(r => setTimeout(r, 20));
        return { response: `re:${prompt}`, sessionId: sessionId || 's1' };
      }
    })();
    const gw = new Gateway(config, new FakeSessions() as any, agent as any, new FakeMemory() as any);

    const streamed1: string[] = [];
    const streamed2: string[] = [];
    const p1 = gw.handleMessage('chat1', 'A', d => streamed1.push(d));
    const p2 = gw.handleMessage('chat1', 'B', d => streamed2.push(d));
    await Promise.all([p1, p2]);

    assert.deepEqual(streamed1, ['stream:A']);
    assert.deepEqual(streamed2, ['stream:B']);
  });

  it('drain resolves when no work pending', async () => {
    const agent = new FakeAgent();
    const gw = new Gateway(config, new FakeSessions() as any, agent as any, new FakeMemory() as any);
    const start = Date.now();
    await gw.drain();
    assert.ok(Date.now() - start < 50);
  });

  it('drain waits for in-flight work', async () => {
    const agent = new FakeAgent();
    agent.delays = [80];
    const gw = new Gateway(config, new FakeSessions() as any, agent as any, new FakeMemory() as any);
    const p = gw.handleMessage('chat1', 'A');
    await new Promise(r => setTimeout(r, 5));
    const drainStart = Date.now();
    await gw.drain();
    const elapsed = Date.now() - drainStart;
    assert.ok(elapsed >= 60, `drain returned too early: ${elapsed}ms`);
    await p;
  });
});
