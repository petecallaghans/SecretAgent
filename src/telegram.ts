import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { randomUUID } from 'crypto';
import type { Config } from './types.js';
import { MODELS, MODEL_DISPLAY, type Gateway } from './gateway.js';

const MAX_MESSAGE_LENGTH = 4096;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class TelegramAdapter {
  private bot: Bot;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(private config: Config, private gateway: Gateway) {
    this.bot = new Bot(config.telegramBotToken);
    this.setupHandlers();
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

      this.gateway.setModel(chatId, modelId);
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
      setTimeout(() => {
        console.log('[telegram] Restart requested via /restart');
        process.exit(0);
      }, 500);
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
      const chatId = ctx.chat.id.toString();
      const text = ctx.message.text;

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const response = await this.gateway.handleMessage(chatId, text);
        clearInterval(typingInterval);
        await this.sendLong(ctx, response || '(no response)');
      } catch (err: unknown) {
        clearInterval(typingInterval);
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Error: ${msg}`);
      }
    });

    // Photos with optional caption
    this.bot.on('message:photo', async (ctx) => {
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

    // Error handler
    this.bot.catch((err) => {
      console.error('Telegram bot error:', err);
    });
  }

  private async sendLong(ctx: Context, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
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
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(Number(chatId), chunk);
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

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx <= 0) splitIdx = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}
