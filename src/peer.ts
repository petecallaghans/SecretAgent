import type { RosterPeer } from './roster.js';
import type { PeerMessage } from './types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Deliver a peer message envelope to another instance's /peer endpoint.
 * Retries on failure (default 2 retries = 3 total attempts). Throws if all fail.
 */
export async function deliverPeerMessage(
  peer: RosterPeer,
  envelope: PeerMessage,
  sharedSecret: string,
  retries = 2,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(peer.peerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sharedSecret}`,
        },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) throw new Error(`peer "${peer.id}" returned HTTP ${res.status}`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await delay(250 * (attempt + 1));
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Failed to reach peer "${peer.id}" after ${retries + 1} attempts: ${reason}`);
}
