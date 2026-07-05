import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { Config, Effort } from './types.js';
import { MODELS, MODEL_DISPLAY, EFFORT_LEVELS, type Gateway } from './gateway.js';
import { runUpdate } from './update.js';
import type { Roster } from './roster.js';

const MAX_MESSAGE_LENGTH = 4096;
/** Reserve headroom for HTML expansion when chunking raw markdown */
const SAFE_RAW_LENGTH = MAX_MESSAGE_LENGTH - 256;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class TelegramAdapter {
  private bot: Bot;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(private config: Config, private gateway: Gateway, private roster: Roster | null = null) {
    this.bot = new Bot(config.telegramBotToken);
    this.setupHandlers();
  }

  /**
   * Decide whether to act on an incoming message.
   * - No roster (single-agent) → always act (classic behavior).
   * - Private chat → always act.
   * - Group/supergroup → act only when addressed (mention, name, id, or reply to me).
   */
  private shouldHandle(ctx: Context): boolean {
    if (!this.roster) return true;
    const type = ctx.chat?.type;
    if (type !== 'group' && type !== 'supergroup') return true;
    return this.isAddressed(ctx);
  }

  private isAddressed(ctx: Context): boolean {
    // Reply to one of my own messages counts as addressing me.
    const reply = ctx.message?.reply_to_message;
    if (reply?.from?.id && ctx.me?.id && reply.from.id === ctx.me.id) return true;

    const text = (ctx.message?.text || ctx.message?.caption || '').toLowerCase();
    if (!text) return false;

    const username = ctx.me?.username?.toLowerCase();
    if (username && text.includes(`@${username}`)) return true;

    const self = this.roster!.self;
    return [self.id, self.name].some(tok => {
      const t = tok.toLowerCase().trim();
      return t.length > 0 && new RegExp(`\\b${escapeRegex(t)}\\b`).test(text);
    });
  }

  /** Strip a standalone @mention of this bot from group text. */
  private stripMention(ctx: Context, text: string): string {
    const username = ctx.me?.username;
    if (!username) return text;
    const stripped = text
      .replace(new RegExp(`@${escapeRegex(username)}\\b`, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return stripped || text;
  }

  private setupHandlers(): void {
    // Auth middleware: filter to allowed users
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
        return;
      }
      await next();
    });

    // /start command
    this.bot.command('start', async (ctx) => {
      await ctx.reply('Hello! I\'m SecretAgent. Send me a message to chat.');
    });

    // /reset - clear session
    this.bot.command('reset', async (ctx) => {
      await this.gateway.resetSession(ctx.chat.id.toString());
      await ctx.reply('Session cleared. Starting fresh.');
    });

    // /memory - show memory
    this.bot.command('memory', async (ctx) => {
      const memory = this.gateway.getMemory();
      await this.sendLong(ctx, memory || '(empty memory)');
    });

    // /model - view or switch model
    this.bot.command('model', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const arg = ctx.match?.trim().toLowerCase();

      if (!arg) {
        const current = this.gateway.getModel(chatId);
        const display = MODEL_DISPLAY[current] || current;
        const available = Object.entries(MODEL_DISPLAY)
          .map(([id, name]) => `  ${id === current ? '→' : ' '} ${name} (\`${id}\`)`)
          .join('\n');
        await ctx.reply(`Current model: ${display}\n\nAvailable:\n${available}\n\nSwitch with: /model <name>\nE.g. /model opus, /model sonnet-4-6`);
        return;
      }

      const modelId = MODELS[arg] || (Object.values(MODELS).includes(arg) ? arg : null);
      if (!modelId) {
        const names = Object.keys(MODELS).join(', ');
        await ctx.reply(`Unknown model. Options: ${names}`);
        return;
      }

      await this.gateway.setModel(chatId, modelId);
      await this.gateway.resetSession(chatId);
      const display = MODEL_DISPLAY[modelId] || modelId;
      await ctx.reply(`Switched to ${display}. Session reset.`);
    });

    // /cron - list cron jobs
    this.bot.command('cron', async (ctx) => {
      const jobs = this.gateway.listCrons();
      if (jobs.length === 0) {
        await ctx.reply('No scheduled tasks. Ask me to set one up!');
      } else {
        const text = jobs.map(j =>
          `- ${j.id}: \`${j.schedule}\` - ${j.prompt} (${j.enabled ? 'active' : 'paused'})`
        ).join('\n');
        await this.sendLong(ctx, text);
      }
    });

    // /effort - view or set effort level
    this.bot.command('effort', async (ctx) => {
      const arg = ctx.match?.trim().toLowerCase() as Effort | undefined;
      const chatId = ctx.chat.id.toString();
      const current = this.gateway.getEffort(chatId);

      if (!arg) {
        const levels = EFFORT_LEVELS
          .map(l => `  ${l === current ? '→' : ' '} ${l}`)
          .join('\n');
        await ctx.reply(`Effort (this chat): ${current}\n\nLevels:\n${levels}\n\nSwitch: /effort <level>`);
        return;
      }

      if (!EFFORT_LEVELS.includes(arg as Effort)) {
        await ctx.reply(`Unknown level. Options: ${EFFORT_LEVELS.join(', ')}`);
        return;
      }

      await this.gateway.setEffort(chatId, arg as Effort);
      await ctx.reply(`Effort set to ${arg} for this chat.`);
    });

    // /think - toggle extended thinking
    this.bot.command('think', async (ctx) => {
      const current = this.gateway.getThinking();
      const next = current === 'disabled' ? 'adaptive' : 'disabled';
      this.gateway.setThinking(next);
      await ctx.reply(`Thinking: ${next === 'adaptive' ? 'ON (adaptive)' : 'OFF'}`);
    });

    // /approve - toggle approval mode
    this.bot.command('approve', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const enabled = this.gateway.toggleApproval(chatId);
      await ctx.reply(enabled
        ? 'Approval mode ON. Shell commands and file writes will require your confirmation.'
        : 'Approval mode OFF. Commands will execute without confirmation.');
    });

    // /restart - restart the bot process
    this.bot.command('restart', async (ctx) => {
      await ctx.reply('Restarting…');
      setTimeout(() => this.selfRestart('restart'), 500);
    });

    // /update - pull latest from git, preserve personal files, restart
    this.bot.command('update', async (ctx) => {
      const sent = await ctx.reply('Starting update...');
      const lines: string[] = ['Starting update...'];
      let lastEdit = 0;
      const flush = async () => {
        const now = Date.now();
        if (now - lastEdit < 1000) return;
        lastEdit = now;
        try {
          await this.bot.api.editMessageText(sent.chat.id, sent.message_id, lines.join('\n'));
        } catch { /* ignore rate limits / unchanged content */ }
      };
      const report = (msg: string) => {
        lines.push(msg);
        void flush();
      };

      try {
        const result = await runUpdate(report);
        const finalLines = [...lines];
        if (result.status === 'up-to-date') {
          finalLines.push('', result.message);
          await this.bot.api.editMessageText(sent.chat.id, sent.message_id, finalLines.join('\n'));
          return;
        }
        if (result.status === 'failed') {
          finalLines.push('', `Update failed: ${result.message}`, '', 'Your personal files are unchanged. No restart needed.');
          await this.bot.api.editMessageText(sent.chat.id, sent.message_id, finalLines.join('\n'));
          return;
        }
        finalLines.push('', result.message, 'Restarting now...');
        await this.bot.api.editMessageText(sent.chat.id, sent.message_id, finalLines.join('\n'));
        setTimeout(() => this.selfRestart('update'), 500);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push('', `Update failed: ${msg}`);
        try {
          await this.bot.api.editMessageText(sent.chat.id, sent.message_id, lines.join('\n'));
        } catch { /* ignore */ }
      }
    });

    // /webhook - list webhooks
    this.bot.command('webhook', async (ctx) => {
      const hooks = this.gateway.listWebhooks();
      if (hooks.length === 0) {
        await ctx.reply('No webhooks configured. Ask me to set one up!');
      } else {
        const text = hooks.map(h =>
          `- ${h.id}: \`${h.path}\` - ${h.prompt} (${h.secret ? 'signed' : 'unsigned'})`
        ).join('\n');
        await this.sendLong(ctx, text);
      }
    });

    // Callback query handler for approval buttons
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('approve:')) return;

      const parts = data.split(':');
      if (parts.length !== 3) return;

      const [, id, decision] = parts;
      const pending = this.pendingApprovals.get(id);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'Expired or already handled.' });
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(id);
      const approved = decision === 'yes';
      pending.resolve(approved);

      await ctx.answerCallbackQuery({ text: approved ? 'Approved' : 'Denied' });
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + `\n\n${approved ? '✅ Approved' : '❌ Denied'}`,
      );
    });

    // Text messages
    this.bot.on('message:text', async (ctx) => {
      if (!this.shouldHandle(ctx)) return;
      const chatId = ctx.chat.id.toString();
      const text = this.stripMention(ctx, ctx.message.text);

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        // Stream response: send a placeholder message, then edit it as content arrives
        let streamedText = '';
        let displayedText = '';
        const stream = { chatId: 0, messageId: 0, active: false };
        let editTimer: ReturnType<typeof setTimeout> | null = null;
        const EDIT_INTERVAL_MS = 1000; // Telegram allows ~1 edit/sec

        const flushEdit = async () => {
          editTimer = null;
          if (!stream.active) return;
          const display = streamedText;
          if (!display || display === displayedText) return;
          const streamHtml = renderForStream(display);
          try {
            await this.bot.api.editMessageText(
              stream.chatId,
              stream.messageId,
              streamHtml + ' ▍',
              { parse_mode: 'HTML' },
            );
            displayedText = display;
          } catch {
            // Telegram may reject edits if content unchanged or rate limited
          }
          // If more content arrived during flush, schedule another edit
          const latest = streamedText;
          if (latest !== displayedText && !editTimer) {
            editTimer = setTimeout(flushEdit, EDIT_INTERVAL_MS);
          }
        };

        const scheduleEdit = () => {
          if (editTimer) return;
          editTimer = setTimeout(flushEdit, EDIT_INTERVAL_MS);
        };

        const onStream = (delta: string) => {
          streamedText += delta;
          if (!stream.active) return;
          scheduleEdit();
        };

        // Send initial placeholder as soon as first visible content arrives
        let initSending = false;
        const onStreamWithInit = async (delta: string) => {
          streamedText += delta;
          if (!stream.active) {
            if (initSending) return; // already sending placeholder
            // Only send placeholder once we have visible (non-thinking) content
            const display = streamedText;
            if (!display) return;
            initSending = true;
            const sent = await ctx.reply('▍');
            stream.chatId = sent.chat.id;
            stream.messageId = sent.message_id;
            stream.active = true;
            scheduleEdit();
            return;
          }
          scheduleEdit();
        };

        const response = await this.gateway.handleMessage(chatId, text, onStreamWithInit);
        clearInterval(typingInterval);
        if (editTimer) clearTimeout(editTimer);

        const finalText = (response || '').trim() || '(no response)';
        const chunks = chunkRaw(finalText);

        // Final update: replace streamed message with first chunk, send rest fresh
        if (stream.active) {
          const firstHtml = formatForTelegram(chunks[0]);
          let edited = false;
          try {
            await this.bot.api.editMessageText(stream.chatId, stream.messageId, firstHtml, { parse_mode: 'HTML' });
            edited = true;
          } catch {
            try { await this.bot.api.deleteMessage(stream.chatId, stream.messageId); } catch { /* ignore */ }
          }
          if (!edited) {
            await this.sendLong(ctx, chunks[0]);
          }
          for (let i = 1; i < chunks.length; i++) {
            await this.sendLong(ctx, chunks[i]);
          }
        } else {
          for (const chunk of chunks) {
            await this.sendLong(ctx, chunk);
          }
        }
      } catch (err: unknown) {
        clearInterval(typingInterval);
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${msg}`);
      }
    });

    // Photos with optional caption
    this.bot.on('message:photo', async (ctx) => {
      if (!this.shouldHandle(ctx)) return;
      const chatId = ctx.chat.id.toString();
      const caption = ctx.message.caption || 'What do you see in this image?';

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1]; // Largest size
        const file = await ctx.api.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`;

        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64 = buffer.toString('base64');

        const result = await this.gateway.handleImage(chatId, base64, caption);
        clearInterval(typingInterval);
        await this.sendLong(ctx, result || '(no response)');
      } catch (err: unknown) {
        clearInterval(typingInterval);
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${msg}`);
      }
    });

    // Voice messages
    this.bot.on('message:voice', async (ctx) => {
      if (!this.shouldHandle(ctx)) return;
      const chatId = ctx.chat.id.toString();
      const caption = ctx.message.caption || undefined;

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const result = await this.gateway.handleVoice(chatId, buffer, caption);
        clearInterval(typingInterval);
        await this.sendLong(ctx, result || '(no response)');
      } catch (err: unknown) {
        clearInterval(typingInterval);
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${msg}`);
      }
    });

    // Video notes (round video messages) — treat like voice
    this.bot.on('message:video_note', async (ctx) => {
      if (!this.shouldHandle(ctx)) return;
      const chatId = ctx.chat.id.toString();

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const file = await ctx.api.getFile(ctx.message.video_note.file_id);
        const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const result = await this.gateway.handleVoice(chatId, buffer);
        clearInterval(typingInterval);
        await this.sendLong(ctx, result || '(no response)');
      } catch (err: unknown) {
        clearInterval(typingInterval);
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${msg}`);
      }
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('Telegram bot error:', err);
    });
  }

  private selfRestart(reason: string): void {
    console.log(`[telegram] Self-restart requested via /${reason}`);
    if (!process.env.INVOCATION_ID) {
      // Not under systemd — self-restart by spawning a new process
      const isDev = process.argv[1]?.endsWith('.ts');
      const cmd = isDev ? 'npm run dev' : 'npm start';
      spawn('sh', ['-c', `sleep 2 && ${cmd}`], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
      }).unref();
    }
    // Under systemd/launchd, Restart=always handles it
    process.exit(0);
  }

  private async sendLong(ctx: Context, text: string): Promise<void> {
    const chunks = chunkRaw(text);
    for (const chunk of chunks) {
      const html = formatForTelegram(chunk);
      try {
        await ctx.reply(html, { parse_mode: 'HTML' });
      } catch {
        // Fallback: send raw markdown if HTML parsing fails
        await ctx.reply(chunk);
      }
    }
  }

  async start(): Promise<void> {
    console.log('Starting Telegram bot (long polling)...');
    await this.bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        console.log(`Bot started as @${botInfo.username}`);
      },
    });
  }

  stop(): void {
    this.bot.stop();
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    const chunks = chunkRaw(text);
    for (const chunk of chunks) {
      const html = formatForTelegram(chunk);
      try {
        await this.bot.api.sendMessage(Number(chatId), html, { parse_mode: 'HTML' });
      } catch {
        await this.bot.api.sendMessage(Number(chatId), chunk);
      }
    }
  }

  async sendFile(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), {
      caption: caption || undefined,
    });
  }

  async requestApproval(chatId: number | string, description: string): Promise<boolean> {
    const id = randomUUID().slice(0, 8);
    const keyboard = new InlineKeyboard()
      .text('Approve', `approve:${id}:yes`)
      .text('Deny', `approve:${id}:no`);

    await this.bot.api.sendMessage(Number(chatId), `🔒 Approval required:\n\n${description}`, {
      reply_markup: keyboard,
    });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve(false);
      }, 2 * 60 * 1000); // 2 minute timeout → auto-deny

      this.pendingApprovals.set(id, { resolve, timeout });
    });
  }
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert Markdown to Telegram-safe HTML */
export function formatForTelegram(text: string): string {
  // Escape HTML first, then apply markdown conversion
  let html = text;
  // Protect code blocks from escaping
  const codeBlocks: string[] = [];
  html = html.replace(/```\w*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // Escape HTML
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Restore code blocks as HTML
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    const code = codeBlocks[Number(idx)].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${code}</code></pre>`;
  });
  html = html.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => {
    const code = inlineCodes[Number(idx)].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${code}</code>`;
  });

  // Headings: # ... → bold text (Telegram has no heading support)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // Horizontal rules: --- or *** or ___ on their own line → blank line
  html = html.replace(/^[-*_]{3,}\s*$/gm, '');
  // Bold: **...** → <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Italic: *...* → <i>...</i>
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  // Strikethrough: ~~...~~ → <s>...</s>
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  return html;
}

/**
 * Split raw markdown so that each chunk's HTML output stays under MAX_MESSAGE_LENGTH.
 * Prefers \n\n then \n boundaries; falls back to a binary search for hard cuts.
 */
export function chunkRaw(text: string): string[] {
  if (formatForTelegram(text).length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (formatForTelegram(remaining).length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cut = Math.min(remaining.length, SAFE_RAW_LENGTH);
    const para = remaining.lastIndexOf('\n\n', cut);
    if (para > cut / 2) cut = para;
    else {
      const line = remaining.lastIndexOf('\n', cut);
      if (line > cut / 2) cut = line;
    }
    // Shrink until HTML fits (handles dense markdown that expands a lot)
    while (cut > 1 && formatForTelegram(remaining.slice(0, cut)).length > MAX_MESSAGE_LENGTH) {
      cut = Math.floor(cut * 0.9);
    }
    if (cut < 1) cut = 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Format text for the streaming preview message: trim raw to a safe length so
 * the rendered HTML plus the cursor glyph fits in one Telegram message.
 */
export function renderForStream(text: string): string {
  let display = text.length > SAFE_RAW_LENGTH
    ? text.slice(0, SAFE_RAW_LENGTH - 1) + '…'
    : text;
  let html = formatForTelegram(display);
  // Reserve 4 chars for ' ▍' cursor suffix
  while (html.length > MAX_MESSAGE_LENGTH - 4 && display.length > 1) {
    display = display.slice(0, Math.floor(display.length * 0.9));
    html = formatForTelegram(display);
  }
  return html;
}
