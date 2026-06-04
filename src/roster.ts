import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Config } from './types.js';

/** One agent in the team. */
export interface RosterPeer {
  id: string;
  name: string;
  role: string;
  peerUrl: string;
}

/** Shape of workspace/roster.json (or the PEER_ROSTER env var). */
export interface RosterFile {
  self: string;
  groupChatId: string;
  /** Bearer secret for peer HTTP. May be a literal, or "env:VAR_NAME" to read from env. */
  sharedSecret?: string;
  peers: RosterPeer[];
}

/**
 * Loaded team roster. Construct via Roster.load(); returns null when no roster
 * is configured, which keeps single-agent behavior identical to before.
 *
 * NOTE: roster.json must be plain JSON (no comments). peerUrls contain "//",
 * so comment-stripping a .jsonc file would corrupt them.
 */
export class Roster {
  /** This instance's own entry. */
  readonly self: RosterPeer;
  /** All agents, including self. */
  readonly all: RosterPeer[];
  /** Teammates (everyone except self). */
  readonly peers: RosterPeer[];
  readonly groupChatId: string;
  readonly sharedSecret: string;

  private constructor(file: RosterFile) {
    const selfPeer = file.peers.find(p => p.id === file.self);
    if (!selfPeer) {
      const ids = file.peers.map(p => p.id).join(', ') || '(none)';
      throw new Error(`Roster 'self' id "${file.self}" not found in peers. Valid ids: ${ids}`);
    }
    this.self = selfPeer;
    this.all = file.peers;
    this.peers = file.peers.filter(p => p.id !== file.self);
    this.groupChatId = file.groupChatId;
    this.sharedSecret = resolveSecret(file.sharedSecret);
  }

  /**
   * Load roster from PEER_ROSTER env (raw JSON) or workspace/roster.json.
   * Returns null when nothing is configured or no peers are listed →
   * collaboration disabled, classic single-agent behavior.
   */
  static async load(config: Config): Promise<Roster | null> {
    let raw: string;
    if (process.env.PEER_ROSTER) {
      raw = process.env.PEER_ROSTER;
    } else {
      const rosterPath = path.join(config.workspaceDir, 'roster.json');
      if (!existsSync(rosterPath)) return null;
      raw = await readFile(rosterPath, 'utf-8');
    }

    let file: RosterFile;
    try {
      file = JSON.parse(raw) as RosterFile;
    } catch (err) {
      throw new Error(`Failed to parse roster (must be plain JSON, no comments): ${(err as Error).message}`);
    }

    if (!Array.isArray(file.peers) || file.peers.length === 0) return null;
    if (!file.self) throw new Error('Roster is missing required "self" field.');

    return new Roster(file);
  }

  /** Resolve a peer by id or name (case-insensitive). Null if unknown. */
  resolvePeer(idOrName: string): RosterPeer | null {
    const key = idOrName.trim().toLowerCase();
    return (
      this.all.find(p => p.id.toLowerCase() === key || p.name.toLowerCase() === key) || null
    );
  }

  /** System-prompt block: who I am, my teammates, and how peer replies work. */
  describe(): string {
    const lines: string[] = ['## Team'];
    lines.push(`You are ${this.self.name} (${this.self.role}), part of a multi-agent team.`);
    if (this.peers.length > 0) {
      const teammates = this.peers.map(p => `${p.name} (${p.role})`).join(', ');
      lines.push(`Your teammates: ${teammates}.`);
      lines.push(
        'You can message a teammate with the `message_peer` tool. Replies arrive later as a ' +
          'new incoming message tagged from that teammate — do not block waiting for a return value.',
      );
    } else {
      lines.push('You currently have no teammates configured.');
    }
    return lines.join('\n');
  }
}

/** Resolve "env:VAR_NAME" to the env value; pass through literals. */
function resolveSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}
