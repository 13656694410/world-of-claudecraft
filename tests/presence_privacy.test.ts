// Presence privacy (server/presence_privacy.ts): /presence everyone | friends |
// none decides who sees a character ONLINE through the social graph. Pinned
// here: the pure rule, the command parse and run, and every point it gates
// (canShowInWho for /who and the live position push, the roster rows, the login
// notices, and the watcher refresh after a change).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../server/db', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  saveCharacterState: vi.fn(async () => {}),
  openPlaySession: vi.fn(async () => 1),
  touchCharacterLogin: vi.fn(async () => {}),
  closePlaySession: vi.fn(async () => {}),
  insertChatLogs: vi.fn(async () => {}),
  walletForAccount: vi.fn(async () => null),
  markAccountQuestComplete: vi.fn(async () => ({ completedQuestIds: [], mechChromaIds: [] })),
  grantAccountMechChroma: vi.fn(async () => ({ completedQuestIds: [], mechChromaIds: [] })),
}));

import { type ClientSession, GameServer } from '../server/game';
import {
  PRESENCE_NOTICES,
  type PresenceCommandHost,
  type PresenceSession,
  parsePresenceCommand,
  presenceHiddenFrom,
  runPresenceCommand,
} from '../server/presence_privacy';
import { type SocialDb, SocialService, type SocialTransport } from '../server/social';
import { canShowInWho } from '../server/who_roster';

const VIEWER = 2;

describe('presenceHiddenFrom: the pure rule', () => {
  it('everyone shows, none hides, friends shows only to the subject’s own friends', () => {
    const friends = new Set([VIEWER]);
    expect(presenceHiddenFrom({ characterId: 1 }, VIEWER), 'absent reads everyone').toBe(false);
    expect(presenceHiddenFrom({ characterId: 1, presenceMode: 'everyone' }, VIEWER)).toBe(false);
    expect(presenceHiddenFrom({ characterId: 1, presenceMode: 'none' }, VIEWER)).toBe(true);
    expect(
      presenceHiddenFrom({ characterId: 1, presenceMode: 'friends', friendIds: friends }, VIEWER),
    ).toBe(false);
    expect(
      presenceHiddenFrom({ characterId: 1, presenceMode: 'friends', friendIds: new Set() }, VIEWER),
    ).toBe(true);
    expect(
      presenceHiddenFrom({ characterId: 1, presenceMode: 'friends' }, VIEWER),
      'a friends list not loaded yet hides (fail closed)',
    ).toBe(true);
    expect(presenceHiddenFrom({ characterId: 1, presenceMode: 'none' }, 1), 'never from self').toBe(
      false,
    );
  });
});

describe('parsePresenceCommand', () => {
  it('reads the three settings and their aliases, the status form and a usage error', () => {
    expect(parsePresenceCommand('/presence')).toEqual({ kind: 'status' });
    expect(parsePresenceCommand('/presence everyone')).toEqual({ kind: 'set', mode: 'everyone' });
    expect(parsePresenceCommand('/presence ALL')).toEqual({ kind: 'set', mode: 'everyone' });
    expect(parsePresenceCommand('/presence friends')).toEqual({ kind: 'set', mode: 'friends' });
    expect(parsePresenceCommand('/presence none')).toEqual({ kind: 'set', mode: 'none' });
    expect(parsePresenceCommand('/presence off')).toEqual({ kind: 'set', mode: 'none' });
    expect(parsePresenceCommand('/presence maybe')).toEqual({ kind: 'usage' });
    expect(parsePresenceCommand('/presences')).toBeNull();
    expect(parsePresenceCommand('hello')).toBeNull();
  });
});

describe('runPresenceCommand', () => {
  function host() {
    const query = vi.fn(async () => ({ rows: [] }));
    const notices: string[] = [];
    const refresh = vi.fn(async () => {});
    const h: PresenceCommandHost<PresenceSession> = {
      pool: { query } as never,
      consumeCommandLane: () => true,
      refreshPresenceWatchers: refresh,
      sendChatNotice: (_s, text) => notices.push(text),
    };
    return { h, query, notices, refresh };
  }

  it('writes a changed setting, refreshes the watchers and confirms it', async () => {
    const { h, query, notices, refresh } = host();
    const session: PresenceSession = {
      accountId: 7,
      characterId: 9,
      name: 'Hider',
      presenceMode: 'everyone',
    };
    await runPresenceCommand(h, session, { kind: 'set', mode: 'none' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE characters SET presence_mode'),
      [9, 'none'],
    );
    expect(session.presenceMode).toBe('none');
    expect(refresh).toHaveBeenCalledOnce();
    expect(notices).toEqual([PRESENCE_NOTICES.none]);
  });

  it('a repeat of the current setting or a status read writes nothing', async () => {
    const { h, query, notices, refresh } = host();
    const session: PresenceSession = {
      accountId: 7,
      characterId: 9,
      name: 'Hider',
      presenceMode: 'friends',
    };
    await runPresenceCommand(h, session, { kind: 'set', mode: 'friends' });
    await runPresenceCommand(h, session, { kind: 'status' });
    expect(query).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(notices).toEqual([PRESENCE_NOTICES.friends, PRESENCE_NOTICES.friends]);
  });
});

describe('canShowInWho honours the candidate’s presence (/who and the position push)', () => {
  const viewer = { characterId: VIEWER, blockListLoaded: true, blockedIds: new Set<number>() };
  const base = { characterId: 1, blockListLoaded: true, blockedIds: new Set<number>() };
  it('hides a none candidate, and a friends candidate from anyone off their list', () => {
    expect(canShowInWho(viewer, base)).toBe(true);
    expect(canShowInWho(viewer, { ...base, presenceMode: 'none' })).toBe(false);
    expect(canShowInWho(viewer, { ...base, presenceMode: 'friends', friendIds: new Set() })).toBe(
      false,
    );
    expect(
      canShowInWho(viewer, { ...base, presenceMode: 'friends', friendIds: new Set([VIEWER]) }),
    ).toBe(true);
  });
});

describe('the live position push on the authoritative server', () => {
  function fakeWs() {
    const sent: { t: string; list?: { id: number }[] }[] = [];
    return { sent, ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } };
  }

  it('stops pushing a hidden friend’s position, and resumes once they show again', () => {
    const server = new GameServer();
    const wfc = fakeWs();
    const watcher = server.join(wfc.ws as never, 1, 1, 'Watcher', 'warrior', null) as ClientSession;
    const tfc = fakeWs();
    const tracked = server.join(tfc.ws as never, 2, 2, 'Tracked', 'warrior', null) as ClientSession;
    watcher.blockListLoaded = true;
    tracked.blockListLoaded = true;
    watcher.socialTrackedIds = [tracked.characterId];
    const push = (): boolean => {
      wfc.sent.length = 0;
      (server as unknown as { broadcastSocialPositions(): void }).broadcastSocialPositions();
      return wfc.sent.some((f) => f.t === 'socialpos');
    };
    expect(push(), 'visible by default').toBe(true);
    tracked.presenceMode = 'none';
    expect(push()).toBe(false);
    tracked.presenceMode = 'friends';
    tracked.friendIds = new Set();
    expect(push(), 'not on the tracked player’s own friends list').toBe(false);
    tracked.friendIds = new Set([watcher.characterId]);
    expect(push()).toBe(true);
  });
});

describe('the social service: roster rows, login notices and the refresh', () => {
  function service(hidden: boolean) {
    const delivered: number[] = [];
    const pushed: number[] = [];
    const db = {
      whoFriended: async () => [2],
      blockedIds: async () => [],
      guildMembership: async () => ({ guildId: 5, guildName: 'G', rank: 'member' }),
      guildMembers: async () => [{ id: 1 }, { id: 3 }],
    } as unknown as SocialDb;
    const tx = {
      isOnline: () => true,
      blockListLoaded: () => true,
      isBlocking: () => false,
      locationOf: () => ({ zone: 'Eastbrook Vale', status: 'online', x: 1, z: 2 }),
      deliver: (id: number) => delivered.push(id),
      pushSnapshot: (id: number) => pushed.push(id),
      presenceHiddenFrom: () => hidden,
    } as unknown as SocialTransport;
    const svc = new SocialService(
      db,
      tx,
      () => 0,
      () => false,
      () => null,
    );
    return { svc, delivered, pushed };
  }

  it('a hidden character reads offline with no zone or position', () => {
    const shown = (service(false).svc as never as { presence: Function }).presence(2, 1, new Set());
    expect(shown).toMatchObject({ online: true, zone: 'Eastbrook Vale', x: 1, z: 2 });
    const hidden = (service(true).svc as never as { presence: Function }).presence(2, 1, new Set());
    expect(hidden).toEqual({ online: false });
  });

  it('a hidden character’s login sends no “has come online” notice', async () => {
    const shown = service(false);
    await shown.svc.announcePresence({ characterId: 1, name: 'Hider' }, true);
    expect(shown.delivered).toContain(2);
    const hidden = service(true);
    await hidden.svc.announcePresence({ characterId: 1, name: 'Hider' }, true);
    expect(hidden.delivered).toEqual([]);
  });

  it('a setting change refreshes the actor and every online friend and guildmate once', async () => {
    const { svc, pushed, delivered } = service(true);
    await svc.refreshPresenceWatchers({ characterId: 1, name: 'Hider' });
    // The actor's own panel first (its Friends footer shows the setting), then
    // each watcher exactly once although the guild roster also lists the actor.
    expect(pushed).toEqual([1, 2, 3]);
    expect(delivered, 'a refresh is silent').toEqual([]);
  });
});
