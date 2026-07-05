import type { ChannelAdapter } from './types.js';

/** Routes namespaced chat ids ("slack:C0ABC", bare Telegram ids) to their adapter. */
export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.prefix, adapter);
  }

  /** Resolve the adapter for a chat id. Bare (un-prefixed) ids are Telegram. */
  resolve(chatId: string): ChannelAdapter {
    const match = /^([a-z]+):/.exec(chatId);
    const prefix = match ? match[1] : 'telegram';
    const adapter = this.adapters.get(prefix);
    if (!adapter) {
      throw new Error(`No channel adapter registered for chat id "${chatId}" (prefix "${prefix}")`);
    }
    return adapter;
  }

  all(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }
}
