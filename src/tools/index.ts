import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeShell } from './shell.js';
import { fetchUrl, webSearch } from './web.js';
import { readFileContent, writeFileContent, listFiles } from './files.js';
import type { Config } from '../types.js';
import type { Memory } from '../memory.js';

export function createToolServer(
  config: Config,
  memory: Memory,
  cronHandler: (action: string, input: Record<string, unknown>) => Promise<string>,
  getChatId: () => string,
) {
  const tools = [
    tool(
      'shell',
      'Execute a shell command and return output. Use for system tasks, running scripts, or inspecting the environment.',
      { command: z.string().describe('The shell command to execute') },
      async ({ command }) => {
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
        const result = await cronHandler(action, {
          action,
          id,
          schedule,
          prompt,
          chatId: Number(getChatId()) || 0,
        });
        return { content: [{ type: 'text' as const, text: result }] };
      },
    ),
  ];

  return createSdkMcpServer({ name: 'secret-agent-tools', tools });
}
