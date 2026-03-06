import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeShell } from './shell.js';
import { fetchUrl, webSearch } from './web.js';
import { readFileContent, writeFileContent, listFiles, resolveSafe } from './files.js';
import type { Config } from '../types.js';
import type { Memory } from '../memory.js';

export interface ToolCallbacks {
  cronHandler: (action: string, input: Record<string, unknown>) => Promise<string>;
  getChatId: () => string;
  sendFile: (chatId: string, filePath: string, caption?: string) => Promise<void>;
  requestApproval: (chatId: string, description: string) => Promise<boolean>;
  isApprovalEnabled: (chatId: string) => boolean;
  webhookHandler: (action: string, input: Record<string, unknown>) => Promise<string>;
}

export function createToolServer(
  config: Config,
  memory: Memory,
  callbacks: ToolCallbacks,
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
      'Search the web via DuckDuckGo and return results.',
      { query: z.string().describe('The search query') },
      async ({ query }) => {
        const result = await webSearch(query);
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
      'save_memory',
      'Replace the entire long-term memory with new content. Use to update memory.md with important facts, preferences, and context.',
      { content: z.string().describe('Full updated content for memory.md') },
      async ({ content }) => {
        await memory.saveMemory(content);
        return { content: [{ type: 'text' as const, text: 'Memory updated successfully.' }] };
      },
    ),
    tool(
      'append_memory',
      'Append a new entry to long-term memory without replacing existing content.',
      { content: z.string().describe('Content to append to memory.md') },
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
  ];

  return createSdkMcpServer({ name: 'secret-agent-tools', tools });
}
