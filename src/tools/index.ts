import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { executeShell } from './shell.js';
import { fetchUrl, webSearch } from './web.js';
import { readFileContent, writeFileContent, listFiles, resolveSafe } from './files.js';
import { searchMemory } from './memorySearch.js';
import { runDelegate } from './delegate.js';
import { deliverPeerMessage } from '../peer.js';
import type { Config, PeerContext, PeerMessage } from '../types.js';
import type { Memory } from '../memory.js';
import type { Roster } from '../roster.js';

/** Hop cap for peer chains — backstop against runaway agent↔agent loops. */
const MAX_HOPS = parseInt(process.env.MAX_HOPS || '8', 10);

export interface ToolCallbacks {
  cronHandler: (action: string, input: Record<string, unknown>) => Promise<string>;
  getChatId: () => string;
  sendFile: (chatId: string, filePath: string, caption?: string) => Promise<void>;
  requestApproval: (chatId: string, description: string) => Promise<boolean>;
  isApprovalEnabled: (chatId: string) => boolean;
  webhookHandler: (action: string, input: Record<string, unknown>) => Promise<string>;
  /** Peer context for the active run (set when processing an inbound peer message). */
  getPeerContext?: () => PeerContext | undefined;
  /** Post a one-liner to the shared group so humans see agent↔agent handoffs. */
  mirrorPeer?: (text: string) => Promise<void>;
}

export function createToolServer(
  config: Config,
  memory: Memory,
  callbacks: ToolCallbacks,
  roster: Roster | null = null,
) {
  const tools = [
    tool(
      'shell',
      'Execute a shell command and return output. Use for system tasks, running scripts, or inspecting the environment.',
      { command: z.string().describe('The shell command to execute') },
      async ({ command }) => {
        const chatId = callbacks.getChatId();
        if (callbacks.isApprovalEnabled(chatId)) {
          const approved = await callbacks.requestApproval(chatId, `Run shell command:\n\`${command}\``);
          if (!approved) {
            return { content: [{ type: 'text' as const, text: 'Action denied by user.' }] };
          }
        }
        const result = await executeShell(command, config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'fetch_url',
      'Fetch content from a URL. Returns text content (HTML is converted to plain text).',
      { url: z.string().describe('The URL to fetch') },
      async ({ url }) => {
        const result = await fetchUrl(url);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'web_search',
      'Search the web and return results (title, URL, snippet). Uses Brave Search when a key is configured, otherwise DuckDuckGo.',
      { query: z.string().describe('The search query') },
      async ({ query }) => {
        const result = await webSearch(query, config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'read_file',
      'Read a file from the workspace directory.',
      { path: z.string().describe('File path relative to workspace') },
      async ({ path }) => {
        const result = await readFileContent(path, config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'write_file',
      'Write content to a file in the workspace directory. Creates parent directories as needed.',
      {
        path: z.string().describe('File path relative to workspace'),
        content: z.string().describe('Content to write'),
      },
      async ({ path, content }) => {
        const chatId = callbacks.getChatId();
        if (callbacks.isApprovalEnabled(chatId)) {
          const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;
          const approved = await callbacks.requestApproval(chatId, `Write file: \`${path}\`\n\n${preview}`);
          if (!approved) {
            return { content: [{ type: 'text' as const, text: 'Action denied by user.' }] };
          }
        }
        const result = await writeFileContent(path, content, config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'list_files',
      'List files and directories in the workspace.',
      { path: z.string().optional().describe('Directory path relative to workspace (default: root)') },
      async ({ path }) => {
        const result = await listFiles(path || '.', config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'send_file',
      'Send a file from the workspace to the user via Telegram.',
      {
        path: z.string().describe('File path relative to workspace'),
        caption: z.string().optional().describe('Optional caption for the file'),
      },
      async ({ path, caption }) => {
        const resolved = resolveSafe(config.workspaceDir, path);
        if (!resolved) {
          return { content: [{ type: 'text' as const, text: 'Error: Path outside workspace directory.' }] };
        }
        try {
          const chatId = callbacks.getChatId();
          await callbacks.sendFile(chatId, resolved, caption);
          return { content: [{ type: 'text' as const, text: `File sent: ${path}` }] };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text' as const, text: `Error sending file: ${msg}` }] };
        }
      },
    ),
    tool(
      'memory_search',
      'Search long-term memory: the memory index, all topic files (memory/topics/), and every daily log. Use this BEFORE saying you don\'t know or don\'t remember something. Case-insensitive; accepts a regex or plain text.',
      { pattern: z.string().describe('Regex or plain text to search for') },
      async ({ pattern }) => {
        const result = await searchMemory(pattern, config);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'save_memory',
      'Replace the memory INDEX (memory.md). Keep it short — one line per topic with a hook, pointing at memory/topics/<slug>.md files. Put substance in topic files via write_file, not here.',
      { content: z.string().describe('Full updated content for memory.md') },
      async ({ content }) => {
        await memory.saveMemory(content);
        return { content: [{ type: 'text' as const, text: 'Memory updated successfully.' }] };
      },
    ),
    tool(
      'append_memory',
      'Append a one-line entry to the memory INDEX (memory.md). For anything longer than a line, write a topic file (memory/topics/<slug>.md) via write_file and add a one-line pointer here. Not for daily notes (use append_log).',
      { content: z.string().describe('One-line entry to append to memory.md') },
      async ({ content }) => {
        await memory.appendMemory(content);
        return { content: [{ type: 'text' as const, text: 'Memory entry appended.' }] };
      },
    ),
    tool(
      'save_soul',
      'Replace your entire soul/personality definition. Use after onboarding to write your personalized identity, or to update your personality later.',
      { content: z.string().describe('Full updated content for soul.md') },
      async ({ content }) => {
        await memory.saveSoul(content);
        return { content: [{ type: 'text' as const, text: 'Soul updated successfully.' }] };
      },
    ),
    tool(
      'append_log',
      'Append to today\'s daily log. Use for conversation notes, observations, things that happened. Logs are loaded for 2 days then drop out of context. For permanent facts, use save_memory.',
      { content: z.string().describe('Content to append to today\'s log') },
      async ({ content }) => {
        await memory.appendLog(content);
        return { content: [{ type: 'text' as const, text: 'Log entry appended.' }] };
      },
    ),
    tool(
      'read_log',
      'Read a daily log by date (YYYY-MM-DD).',
      { date: z.string().describe('Date in YYYY-MM-DD format') },
      async ({ date }) => {
        const log = await memory.getLog(date);
        return { content: [{ type: 'text' as const, text: log || '(no log for this date)' }] };
      },
    ),
    tool(
      'manage_cron',
      'Create, list, or delete scheduled tasks (cron jobs) that run prompts on a schedule and send results via Telegram.',
      {
        action: z.enum(['create', 'list', 'delete']).describe('Action to perform'),
        id: z.string().optional().describe('Cron job ID (required for delete)'),
        schedule: z.string().optional().describe('Cron expression, e.g. "0 9 * * *" for daily at 9am (required for create)'),
        prompt: z.string().optional().describe('Prompt to execute on schedule (required for create)'),
      },
      async ({ action, id, schedule, prompt }) => {
        const result = await callbacks.cronHandler(action, {
          action,
          id,
          schedule,
          prompt,
          chatId: Number(callbacks.getChatId()) || 0,
        });
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    tool(
      'delegate',
      [
        'Hand off a pure text-transform subtask to an external helper model (OpenAI).',
        'Prefer the native researcher/worker subagents (Task tool) — they have tools and stay on your plan.',
        'Use delegate only for isolated text work when subagents are overkill or unavailable:',
        'reformatting, classifying, extracting fields, translating, generating regex, parsing JSON.',
        'The helper has NO conversation history and NO tools — include all needed context in the task.',
        'Tiers: nano = trivial, mini = default, smart = harder rewrites. Set json=true for a parseable JSON object.',
      ].join(' '),
      {
        task: z.string().describe('Self-contained instruction. Include all context the helper needs.'),
        tier: z.enum(['nano', 'mini', 'smart']).optional().describe('Helper size. Default mini.'),
        json: z.boolean().optional().describe('Force JSON object response.'),
        system: z.string().optional().describe('Optional system instruction for the helper. Default is generic.'),
      },
      async ({ task, tier, json, system }) => {
        try {
          const result = await runDelegate(config, { task, tier, json, system });
          return { content: [{ type: 'text' as const, text: result }] };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text' as const, text: `Delegate error: ${msg}` }] };
        }
      },
    ),
    tool(
      'manage_webhook',
      'Create, list, or delete webhooks that trigger agent prompts when HTTP requests are received.',
      {
        action: z.enum(['create', 'list', 'delete']).describe('Action to perform'),
        id: z.string().optional().describe('Webhook ID (required for delete)'),
        path: z.string().optional().describe('URL path to listen on, e.g. "/github" (required for create)'),
        prompt: z.string().optional().describe('Prompt template. Use {{payload}} for full body, {{key}} for JSON fields (required for create)'),
        secret: z.string().optional().describe('HMAC-SHA256 secret for signature verification (optional, for create)'),
      },
      async ({ action, id, path, prompt, secret }) => {
        const result = await callbacks.webhookHandler(action, {
          action,
          id,
          path,
          prompt,
          secret,
          chatId: Number(callbacks.getChatId()) || 0,
        });
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
    // Peer messaging — only registered when a team roster is configured.
    ...(roster ? [buildMessagePeerTool(roster, callbacks)] : []),
  ];

  return createSdkMcpServer({ name: 'secret-agent-tools', tools });
}

/** message_peer tool: hand off / reply to a teammate over the private peer channel. */
function buildMessagePeerTool(roster: Roster, callbacks: ToolCallbacks) {
  const validPeers = () =>
    roster.peers.map(p => `${p.id} (${p.name}, ${p.role})`).join('; ') || '(none)';

  return tool(
    'message_peer',
    [
      'Send a message to a teammate agent over the private peer channel.',
      'Use this to hand off work, ask a question, or reply to a teammate.',
      'Their reply arrives LATER as a new incoming message — do not wait for a return value here.',
      `Valid teammates: ${validPeers()}.`,
      'The handoff is mirrored to the group so humans can follow along.',
    ].join(' '),
    {
      to: z.string().describe('Teammate id or name (e.g. "bob" or "Bob")'),
      message: z.string().describe('Natural-language message to the teammate'),
      payload: z.unknown().optional().describe('Optional structured data to attach'),
    },
    async ({ to, message, payload }) => {
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

      const peer = roster.resolvePeer(to);
      if (!peer) return text(`Unknown teammate "${to}". Valid teammates: ${validPeers()}.`);
      if (peer.id === roster.self.id) return text('You cannot message yourself.');

      const ctx = callbacks.getPeerContext?.();
      const hops = (ctx?.hops ?? 0) + 1;
      if (hops > MAX_HOPS) {
        await callbacks.mirrorPeer?.(
          `⚠️ Hop limit (${MAX_HOPS}) reached on this chain — needs a human. Message to ${peer.name} not sent.`,
        );
        return text(`Hop limit (${MAX_HOPS}) reached. Chain halted — a human must step in.`);
      }

      const envelope: PeerMessage = {
        msgId: randomUUID(),
        from: roster.self.id,
        to: peer.id,
        message,
        payload,
        replyTo: ctx?.replyTo,
        chainId: ctx?.chainId ?? randomUUID(),
        hops,
      };

      try {
        await deliverPeerMessage(peer, envelope, roster.sharedSecret);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await callbacks.mirrorPeer?.(`⚠️ Couldn't reach ${peer.name}: ${msg}`);
        return text(`Failed to deliver message to ${peer.name}: ${msg}`);
      }

      await callbacks.mirrorPeer?.(`→ ${peer.name}: ${message}`);
      return text(`Message sent to ${peer.name}. Their reply will arrive as a new message.`);
    },
  );
}
