import http from 'http';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config, WebhookDef, PeerMessage } from './types.js';
import type { Roster } from './roster.js';

const PEER_PATH = '/peer';

export class WebhookServer {
  private server: http.Server;
  private webhooks = new Map<string, WebhookDef>();
  private webhookFile: string;
  private onFire?: (webhook: WebhookDef, payload: string) => Promise<void>;
  private onPeer?: (env: PeerMessage) => Promise<void>;

  constructor(private config: Config, private roster: Roster | null = null) {
    this.webhookFile = path.join(config.dataDir, 'webhooks.json');
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  setFireHandler(handler: (webhook: WebhookDef, payload: string) => Promise<void>): void {
    this.onFire = handler;
  }

  setPeerHandler(handler: (env: PeerMessage) => Promise<void>): void {
    this.onPeer = handler;
  }

  async init(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    const defs = await this.loadDefs();
    for (const def of defs) {
      this.webhooks.set(def.id, def);
    }
    if (defs.length > 0) {
      console.log(`Restored ${defs.length} webhook(s)`);
    }

    return new Promise((resolve) => {
      this.server.listen(this.config.webhookPort, () => {
        console.log(`Webhook server listening on port ${this.config.webhookPort}`);
        resolve();
      });
    });
  }

  async create(webhookPath: string, prompt: string, chatId: number, secret?: string): Promise<WebhookDef> {
    // Ensure path starts with /
    const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;
    const id = `wh_${Date.now().toString(36)}`;
    const def: WebhookDef = { id, path: normalizedPath, prompt, chatId, secret };
    this.webhooks.set(id, def);
    await this.saveDefs();
    return def;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.webhooks.has(id)) return false;
    this.webhooks.delete(id);
    await this.saveDefs();
    return true;
  }

  list(): WebhookDef[] {
    return Array.from(this.webhooks.values());
  }

  async handleToolAction(action: string, input: Record<string, unknown>): Promise<string> {
    switch (action) {
      case 'create': {
        if (!input.path || !input.prompt) {
          return 'Error: path and prompt are required for create.';
        }
        const def = await this.create(
          input.path as string,
          input.prompt as string,
          (input.chatId as number) || 0,
          input.secret as string | undefined,
        );
        return `Created webhook: ${def.id} → ${def.path}`;
      }
      case 'list': {
        const hooks = this.list();
        if (hooks.length === 0) return 'No webhooks configured.';
        return hooks.map(h =>
          `${h.id}: ${h.path} - ${h.prompt} (${h.secret ? 'signed' : 'unsigned'})`
        ).join('\n');
      }
      case 'delete': {
        if (!input.id) return 'Error: id is required for delete.';
        const deleted = await this.delete(input.id as string);
        return deleted ? `Deleted webhook: ${input.id}` : `Webhook not found: ${input.id}`;
      }
      default:
        return `Unknown webhook action: ${action}`;
    }
  }

  stop(): void {
    this.server.close();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const urlPath = req.url || '/';

      // Private agent↔agent peer channel — handled before the webhook map.
      if (urlPath === PEER_PATH) {
        this.handlePeer(req, res, body);
        return;
      }

      // Find matching webhook by path
      const webhook = Array.from(this.webhooks.values()).find(w => w.path === urlPath);
      if (!webhook) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Verify HMAC signature if secret is configured
      if (webhook.secret) {
        const signature = req.headers['x-signature-256'] as string | undefined;
        if (!signature) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Missing signature');
          return;
        }
        const expected = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        // Length check first — timingSafeEqual throws on mismatched lengths
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Invalid signature');
          return;
        }
      }

      // Respond immediately
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');

      // Process async
      this.fireWebhook(webhook, body).catch(err => {
        console.error(`Webhook ${webhook.id} processing error:`, err);
      });
    });
  }

  /** Handle an inbound peer message: Bearer auth, validate envelope, fire async. */
  private handlePeer(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const sendJson = (status: number, obj: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (!this.roster || !this.onPeer) {
      sendJson(404, { error: 'Peer channel not enabled.' });
      return;
    }

    // Bearer auth against the shared secret (constant-time compare).
    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${this.roster.sharedSecret}`;
    const authBuf = Buffer.from(auth);
    const expBuf = Buffer.from(expected);
    if (
      !this.roster.sharedSecret ||
      authBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(authBuf, expBuf)
    ) {
      sendJson(401, { error: 'Unauthorized' });
      return;
    }

    let env: PeerMessage;
    try {
      const parsed = JSON.parse(body) as Partial<PeerMessage>;
      if (typeof parsed.from !== 'string' || typeof parsed.message !== 'string') {
        sendJson(400, { error: 'Invalid envelope: "from" and "message" are required.' });
        return;
      }
      const msgId = typeof parsed.msgId === 'string' ? parsed.msgId : randomUUID();
      env = {
        msgId,
        from: parsed.from,
        to: typeof parsed.to === 'string' ? parsed.to : this.roster.self.id,
        message: parsed.message,
        payload: parsed.payload,
        replyTo: typeof parsed.replyTo === 'string' ? parsed.replyTo : undefined,
        chainId: typeof parsed.chainId === 'string' ? parsed.chainId : msgId,
        hops: typeof parsed.hops === 'number' ? parsed.hops : 0,
      };
    } catch {
      sendJson(400, { error: 'Invalid JSON.' });
      return;
    }

    // Accept now; the reply (if any) returns async via a peer message and/or group post.
    sendJson(202, { accepted: true, msgId: env.msgId });
    console.log(`Peer message accepted: ${env.msgId} from ${env.from} (chain ${env.chainId}, hop ${env.hops})`);
    this.onPeer(env).catch(err => {
      console.error(`Peer message ${env.msgId} processing error:`, err);
    });
  }

  private async fireWebhook(webhook: WebhookDef, body: string): Promise<void> {
    if (!this.onFire) return;

    // Interpolate prompt
    let prompt = webhook.prompt.replace(/\{\{payload\}\}/g, body);

    // Replace {{key}} placeholders with JSON field values
    try {
      const json = JSON.parse(body);
      if (typeof json === 'object' && json !== null) {
        prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
          const val = json[key];
          return val !== undefined ? String(val) : `{{${key}}}`;
        });
      }
    } catch {
      // Body is not JSON, only {{payload}} substitution applies
    }

    console.log(`Webhook fired: ${webhook.id} (${webhook.path})`);
    await this.onFire(webhook, prompt);
  }

  private async loadDefs(): Promise<WebhookDef[]> {
    if (!existsSync(this.webhookFile)) return [];
    try {
      const content = await readFile(this.webhookFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  private async saveDefs(): Promise<void> {
    const defs = Array.from(this.webhooks.values());
    await writeFile(this.webhookFile, JSON.stringify(defs, null, 2), 'utf-8');
  }
}
