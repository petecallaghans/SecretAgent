/**
 * A chat surface the agent lives on (Telegram, Slack, ...).
 *
 * Chat ids are namespaced strings: bare numeric ids are Telegram (legacy —
 * keeps existing sessions/crons/webhooks working with zero migration);
 * other channels prefix their ids, e.g. "slack:C0ABC123". Adapters receive
 * the full namespaced id and strip their own prefix.
 */
export interface ChannelAdapter {
  /** Namespace prefix, e.g. "telegram" or "slack". Telegram also owns bare ids. */
  readonly prefix: string;
  start(): Promise<void>;
  stop(): void;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  /** Ask the human to approve an action. Resolves false on deny or timeout. */
  requestApproval(chatId: string, description: string): Promise<boolean>;
}
