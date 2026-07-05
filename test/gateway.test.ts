import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../src/gateway.js';
import { testConfig } from './helpers.js';

const config = testConfig();

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
  map = new Map<string, { sessionId: string; count: number }>();
  getSessionId(chatId: string) { return this.map.get(chatId)?.sessionId; }
  getCount(chatId: string) { return this.map.get(chatId)?.count ?? 0; }
  async setSessionId(chatId: string, id: string) {
    const prev = this.map.get(chatId);
    this.map.set(chatId, { sessionId: id, count: (prev?.count ?? 0) + 1 });
  }
  async clearSession(chatId: string) { this.map.delete(chatId); }
}

class FakeMemory {
  getMemory() { return ''; }
}

class FakePrefs {
  store = new Map<string, { model?: string; effort?: string }>();
  get(chatId: string) { return this.store.get(chatId) || {}; }
  async set(chatId: string, patch: object) {
    this.store.set(chatId, { ...this.store.get(chatId), ...patch });
  }
}

function makeGateway(agent = new FakeAgent(), cfg = config, sessions = new FakeSessions()) {
  return {
    gw: new Gateway(cfg, sessions as any, agent as any, new FakeMemory() as any, null, new FakePrefs() as any),
    agent,
    sessions,
  };
}

describe('Gateway', () => {
  it('serializes messages for the same chat', async () => {
    const agent = new FakeAgent();
    agent.delays = [50, 10, 10];
    const { gw } = makeGateway(agent);

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
    const { gw } = makeGateway(agent);

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
    const { gw } = makeGateway(agent);

    const streamed1: string[] = [];
    const streamed2: string[] = [];
    const p1 = gw.handleMessage('chat1', 'A', d => streamed1.push(d));
    const p2 = gw.handleMessage('chat1', 'B', d => streamed2.push(d));
    await Promise.all([p1, p2]);

    assert.deepEqual(streamed1, ['stream:A']);
    assert.deepEqual(streamed2, ['stream:B']);
  });

  it('drain resolves when no work pending', async () => {
    const { gw } = makeGateway();
    const start = Date.now();
    await gw.drain();
    assert.ok(Date.now() - start < 50);
  });

  it('drain waits for in-flight work', async () => {
    const agent = new FakeAgent();
    agent.delays = [80];
    const { gw } = makeGateway(agent);
    const p = gw.handleMessage('chat1', 'A');
    await new Promise(r => setTimeout(r, 5));
    const drainStart = Date.now();
    await gw.drain();
    const elapsed = Date.now() - drainStart;
    assert.ok(elapsed >= 60, `drain returned too early: ${elapsed}ms`);
    await p;
  });

  it('routes voice to the chat default model, cron/webhook/system to light', () => {
    const { gw } = makeGateway();
    assert.equal(gw.selectModel('c', 'hi', 'voice'), config.modelDefault);
    assert.equal(gw.selectModel('c', 'hi', 'cron'), config.modelLight);
    assert.equal(gw.selectModel('c', 'hi', 'webhook'), config.modelLight);
    assert.equal(gw.selectModel('c', 'hi', 'system'), config.modelLight);
    assert.equal(gw.selectModel('c', '/deep hi', 'user'), config.modelDeep);
  });

  it('selectEffort: /deep bumps to high, per-chat pref wins otherwise', async () => {
    const { gw } = makeGateway();
    assert.equal(gw.selectEffort('c', '/deep hi', 'user'), 'high');
    assert.equal(gw.selectEffort('c', 'hi', 'user'), config.effort);
    await gw.setEffort('c', 'max');
    assert.equal(gw.selectEffort('c', 'hi', 'user'), 'max');
    // Background sources ignore per-chat pref
    assert.equal(gw.selectEffort('c', 'hi', 'cron'), config.effort);
  });

  it('rotates the session after sessionMaxMessages user exchanges', async () => {
    const agent = new FakeAgent();
    const sessions = new FakeSessions();
    const cfg = testConfig({ sessionMaxMessages: 2 });
    const { gw } = makeGateway(agent, cfg, sessions);

    await gw.handleMessage('chat1', 'one');
    assert.equal(sessions.getCount('chat1'), 1);
    await gw.handleMessage('chat1', 'two');
    await gw.drain(); // wrap-up turn is queued behind the triggering message

    // Third agent call is the rotation wrap-up, and the session is gone
    assert.equal(agent.calls.length, 3);
    assert.match(agent.calls[2], /rotated/);
    assert.equal(sessions.getSessionId('chat1'), undefined);
  });
});
