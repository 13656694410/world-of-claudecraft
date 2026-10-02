import type { Pool } from 'pg';
import { acquireFlairCommand } from './flair_command_guard';

// Presence privacy (owner rule, 2026-10-02: "hide themselves from friends like in
// RuneScape, all/friends/off, so they can't be seen on the minimap"): who sees
// this character as ONLINE through the social graph. Hidden means exactly what a
// block already means for presence, applied at the same four points:
//   - the friends list and guild roster rows (online, zone, status, live x/z),
//     server/social.ts presence();
//   - the "has come online" notices, social.ts announcePresence();
//   - the once-a-second live position push (socialpos) and /who, both through
//     canShowInWho (server/who_roster.ts).
// The minimap's friend dot and guild diamond follow from the rows (the client
// draws them only for an ONLINE friend or guildmate), so a hidden character is
// no longer tracked through walls. Party members are never affected: the party
// frames and party minimap discs are a separate, consented channel. Nearby
// players still see the character's body in the world, as with any stranger.
//
//   everyone  the default: friends and guildmates see you online
//   friends   only characters on YOUR friends list do (the RuneScape rule)
//   none      nobody does: you appear offline to every friend and guildmate
//
// Per character, persisted in characters.presence_mode (social_db.ts schema).

export type PresenceMode = 'everyone' | 'friends' | 'none';

export const PRESENCE_MODES: readonly PresenceMode[] = ['everyone', 'friends', 'none'];

/** The minimal view of the character whose presence is being shown. */
export interface PresenceSubject {
  characterId: number;
  /** Absent reads as 'everyone' (the default, and a session still loading). */
  presenceMode?: PresenceMode;
  /** The subject's own friends list, for the 'friends' mode. */
  friendIds?: ReadonlySet<number>;
}

/** True when `subject` hides their online presence from `viewerCharId`. */
export function presenceHiddenFrom(subject: PresenceSubject, viewerCharId: number): boolean {
  if (subject.characterId === viewerCharId) return false;
  const mode = subject.presenceMode ?? 'everyone';
  if (mode === 'everyone') return false;
  if (mode === 'none') return true;
  return !(subject.friendIds?.has(viewerCharId) ?? false);
}

export function isPresenceMode(value: unknown): value is PresenceMode {
  return typeof value === 'string' && (PRESENCE_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadPresenceMode(pool: Pool, characterId: number): Promise<PresenceMode> {
  const res = await pool.query('SELECT presence_mode FROM characters WHERE id = $1', [characterId]);
  const value = (res.rows[0] as { presence_mode?: unknown } | undefined)?.presence_mode;
  return isPresenceMode(value) ? value : 'everyone';
}

export async function savePresenceMode(
  pool: Pool,
  characterId: number,
  mode: PresenceMode,
): Promise<void> {
  await pool.query('UPDATE characters SET presence_mode = $2 WHERE id = $1', [characterId, mode]);
}

// ---------------------------------------------------------------------------
// The /presence command
// ---------------------------------------------------------------------------

export type PresenceCommand =
  | { kind: 'status' }
  | { kind: 'set'; mode: PresenceMode }
  | { kind: 'usage' };

/** The exact English the client re-localizes (the presence.* rows in src/ui/server_i18n.ts). */
export const PRESENCE_NOTICES = {
  everyone:
    'Friends and guildmates can see you online. Type /presence friends or /presence none to hide.',
  friends:
    'Only your friends can see you online. Type /presence everyone or /presence none to change it.',
  none: 'You appear offline to friends and guildmates. Type /presence everyone or /presence friends to change it.',
  usage: 'Usage: /presence, /presence everyone, /presence friends, or /presence none.',
} as const;

const ARG_MODES: Readonly<Record<string, PresenceMode>> = {
  everyone: 'everyone',
  all: 'everyone',
  on: 'everyone',
  friends: 'friends',
  none: 'none',
  off: 'none',
};

/** Parse a chat line as /presence, or null when it is not one. Any other argument is a usage error. */
export function parsePresenceCommand(text: string): PresenceCommand | null {
  const match = /^\/presence(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const arg = (match[1] ?? '').trim().toLowerCase();
  if (arg === '') return { kind: 'status' };
  const mode = ARG_MODES[arg];
  return mode ? { kind: 'set', mode } : { kind: 'usage' };
}

/** The live session fields the command reads and writes. */
export interface PresenceSession {
  accountId: number;
  characterId: number;
  name: string;
  presenceMode: PresenceMode;
}

/** What the command needs from GameServer, so it never reaches into the coordinator. */
export interface PresenceCommandHost<S extends PresenceSession> {
  pool: Pool;
  /** Draw the command lane; false when the sender is throttled. */
  consumeCommandLane(session: S, nowSec: number): boolean;
  /** Re-send every online friend's and guildmate's panel so the change shows now. */
  refreshPresenceWatchers(session: S): Promise<void>;
  sendChatNotice(session: S, text: string): void;
}

/** The /presence host shares the /flair host's pool, command lane and notice
 *  sender, plus the one thing only presence needs: the watcher refresh. */
export function presenceHostFrom<S extends PresenceSession>(
  flair: Pick<PresenceCommandHost<S>, 'pool' | 'consumeCommandLane' | 'sendChatNotice'>,
  refreshPresenceWatchers: (session: S) => Promise<void>,
): PresenceCommandHost<S> {
  return {
    pool: flair.pool,
    consumeCommandLane: (session, nowSec) => flair.consumeCommandLane(session, nowSec),
    sendChatNotice: (session, text) => flair.sendChatNotice(session, text),
    refreshPresenceWatchers,
  };
}

/** Run a parsed /presence command: write the setting, refresh the watchers, tell the sender. */
export async function runPresenceCommand<S extends PresenceSession>(
  host: PresenceCommandHost<S>,
  session: S,
  cmd: PresenceCommand,
): Promise<void> {
  if (cmd.kind === 'usage') {
    host.sendChatNotice(session, PRESENCE_NOTICES.usage);
    return;
  }
  if (cmd.kind === 'set' && cmd.mode !== session.presenceMode) {
    await savePresenceMode(host.pool, session.characterId, cmd.mode);
    session.presenceMode = cmd.mode;
    await host.refreshPresenceWatchers(session);
  }
  host.sendChatNotice(session, PRESENCE_NOTICES[session.presenceMode]);
}

/**
 * Claim a chat line as /presence. Returns false when it is not one, so the chat
 * dispatch carries on. A claimed line pays the command lane like /flair (it does
 * a DB write and a roster refresh fan-out), and is never broadcast as chat.
 */
export function handlePresenceChatCommand<S extends PresenceSession>(
  host: PresenceCommandHost<S>,
  session: S,
  text: string,
  nowSec: number,
): boolean {
  const cmd = parsePresenceCommand(text);
  if (!cmd) return false;
  if (!host.consumeCommandLane(session, nowSec)) return true;
  const release = acquireFlairCommand(host, session, nowSec);
  if (!release) return true;
  void runPresenceCommand(host, session, cmd)
    .catch((err) => console.error('presence command failed:', err))
    .finally(release);
  return true;
}
