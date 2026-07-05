import pkg from '@slack/bolt';
import { randomUUID } from 'crypto';
import path from 'path';
import type { Config } from '../types.js';
import type { Gateway } from '../gateway.js';
import type { ChannelAdapter } from './types.js';

const { App } = pkg;

const MAX_SLACK_LENGTH = 3900;
const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Slack channel adapter via Socket Mode — no public URL needed, mirrors
 * Telegram long polling. Requires SLACK_BOT_TOKEN (xoxb-) + SLACK_APP_TOKEN
 * (xapp-, connections:write). Listens to DMs and @mentions in channels.
 */
export class SlackAdapter implements ChannelAdapter {
  readonly prefix = 'slack';
  private app: InstanceType<typeof App>;
  private pendingApprovals = new Map<string, PendingApproval>();
  private botUserId = '';

  constructor(private config: Config, private gateway: Gateway) {
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
    });
    this.setupHandlers();
  }

  private allowed(userId: string | undefined): boolean {
    if (!userId) return false;
    if (this.config.slackAllowedUsers.length === 0) return true;
    return this.config.slackAllowedUsers.includes(userId);
  }

  private setupHandlers(): void {
    // Direct messages
    this.app.message(async ({ message, say }) => {
      const msg = message as unknown as Record<string, unknown>;
      if (msg.subtype || msg.bot_id) return; // edits, joins, bot echoes
      if ((msg.channel_type as string) !== 'im') return; // channels need an @mention
      if (!this.allowed(msg.user as string)) return;
      const text = (msg.text as string || '').trim();
      if (!text) return;
      await this.processAndReply(msg.channel as string, text, say);
    });

    // @mentions in channels
    this.app.event('app_mention', async ({ event, say }) => {
      if (!this.allowed(event.user)) return;
      const text = (event.text || '').replace(/<@[^>]+>/g, '').trim();
      if (!text) return;
      await this.processAndReply(event.channel, text, say);
    });

    // Approval buttons
    this.app.action(/^approve_(yes|no)$/, async ({ action, ack, respond }) => {
      await ack();
      const value = (action as { value?: string }).value || '';
      const [id, decision] = value.split(':');
      const pending = this.pendingApprovals.get(id);
      if (!pending) {
        await respond({ text: 'Expired or already handled.', replace_original: false });
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(id);
      const approved = decision === 'yes';
      pending.resolve(approved);
      await respond({ text: approved ? '✅ Approved' : '❌ Denied', replace_original: true });
    });

    this.app.error(async (err) => {
      console.error('Slack error:', err);
    });
  }

  private async processAndReply(
    channel: string,
    text: string,
    say: (msg: string | { text: string }) => Promise<unknown>,
  ): Promise<void> {
    const chatId = `${this.prefix}:${channel}`;
    try {
      const response = await this.gateway.handleMessage(chatId, text);
      const finalText = (response || '').trim() || '(no response)';
      for (const chunk of chunkForSlack(formatForSlack(finalText))) {
        await say({ text: chunk });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await say({ text: `Error: ${msg}` }).catch(() => { /* ignore */ });
    }
  }

  private channelOf(chatId: string): string {
    return chatId.startsWith(`${this.prefix}:`) ? chatId.slice(this.prefix.length + 1) : chatId;
  }

  async start(): Promise<void> {
    await this.app.start();
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = (auth.user_id as string) || '';
      console.log(`Slack connected as ${auth.user || this.botUserId} (socket mode)`);
    } catch {
      console.log('Slack connected (socket mode)');
    }
  }

  stop(): void {
    void this.app.stop();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const channel = this.channelOf(chatId);
    for (const chunk of chunkForSlack(formatForSlack(text))) {
      await this.app.client.chat.postMessage({ channel, text: chunk });
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    await this.app.client.files.uploadV2({
      channel_id: this.channelOf(chatId),
      file: filePath,
      filename: path.basename(filePath),
      initial_comment: caption,
    });
  }

  async requestApproval(chatId: string, description: string): Promise<boolean> {
    const id = randomUUID().slice(0, 8);
    await this.app.client.chat.postMessage({
      channel: this.channelOf(chatId),
      text: `🔒 Approval required:\n\n${description}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `🔒 *Approval required:*\n\n${formatForSlack(description)}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'approve_yes',
              value: `${id}:yes`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'approve_no',
              value: `${id}:no`,
            },
          ],
        },
      ],
    });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(id, { resolve, timeout });
    });
  }
}

/**
 * Convert common Markdown to Slack mrkdwn: **bold** → *bold*, headings → bold
 * lines, [text](url) → <url|text>, ~~strike~~ → ~strike~. Code blocks and
 * inline code pass through untouched (Slack shares the backtick syntax).
 */
export function formatForSlack(text: string): string {
  // Protect code from conversion
  const codeBlocks: string[] = [];
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });
  const inlineCodes: string[] = [];
  out = out.replace(/`[^`]+`/g, (m) => {
    inlineCodes.push(m);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  // Headings → bold lines
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Bold: ** → placeholder, then italic single * → _, then restore bold as *
  out = out.replace(/\*\*(.+?)\*\*/g, '\x00B\x00$1\x00B\x00');
  out = out.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '_$1_');
  out = out.replace(/\x00B\x00/g, '*');
  // Strikethrough: ~~ → ~
  out = out.replace(/~~(.+?)~~/g, '~$1~');
  // Horizontal rules → blank
  out = out.replace(/^[-*_]{3,}\s*$/gm, '');

  out = out.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  out = out.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);
  return out;
}

/** Split at paragraph/line boundaries so each message stays under Slack's limit. */
export function chunkForSlack(text: string): string[] {
  if (text.length <= MAX_SLACK_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_SLACK_LENGTH) {
    let cut = MAX_SLACK_LENGTH;
    const para = remaining.lastIndexOf('\n\n', cut);
    if (para > cut / 2) cut = para;
    else {
      const line = remaining.lastIndexOf('\n', cut);
      if (line > cut / 2) cut = line;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
