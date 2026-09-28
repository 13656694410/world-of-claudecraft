import { describe, expect, it } from 'vitest';
import { createVaultRewardsDb } from '../../server/vault_rewards_db';

const outcome = {
  attemptId: '42:7',
  ownerCharacterId: 42,
  claims: [
    {
      characterId: 42,
      recipientName: 'Owner',
      items: [{ itemId: 'rusty_hatchet', count: 1 }],
      copper: 25,
      mailDueAt: new Date('2026-09-24T00:00:00.000Z'),
    },
  ],
};

describe('vault rewards database boundary', () => {
  it('rejects duplicate recipients before starting a transaction', async () => {
    let connects = 0;
    const db = createVaultRewardsDb(
      {
        async connect() {
          connects++;
          throw new Error('should not connect');
        },
        async query() {
          throw new Error('should not query');
        },
      },
      'TestRealm',
    );
    await expect(
      db.commitVaultOutcome({ ...outcome, claims: [outcome.claims[0], outcome.claims[0]] }),
    ).rejects.toThrow('duplicate character');
    expect(connects).toBe(0);
  });

  it('caps completion to one party of five before starting a transaction', async () => {
    const db = createVaultRewardsDb(
      {
        async connect() {
          throw new Error('should not connect');
        },
        async query() {
          throw new Error('should not query');
        },
      },
      'TestRealm',
    );
    await expect(
      db.commitVaultOutcome({
        ...outcome,
        claims: Array.from({ length: 6 }, (_, i) => ({
          ...outcome.claims[0],
          characterId: i + 1,
        })),
      }),
    ).rejects.toThrow('1 to 5');
  });

  // Live bug: every hoard cleared by a group never opened its chest. The guest
  // allowance statement bound one parameter to a BIGINT column AND to
  // characters.id, an INTEGER (SERIAL) in production, so Postgres deduced two
  // types for it and refused the statement (42P08) on every retry. The opt-in
  // real-Postgres suite now builds characters with the production id type; this
  // pin keeps the rule where no database is available: every placeholder of a
  // statement that reads the characters table carries an explicit type.
  it('types every parameter of the guest allowance statement that reads characters', async () => {
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        if (/INSERT INTO vault_reward_outcomes/.test(text)) return { rowCount: 1, rows: [{}] };
        if (/SELECT existing_payouts/.test(text))
          return { rowCount: 1, rows: [{ existing_payouts: 0 }] };
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const db = createVaultRewardsDb(
      {
        async connect() {
          return client;
        },
        async query() {
          throw new Error('should not query outside the transaction');
        },
      } as unknown as Parameters<typeof createVaultRewardsDb>[0],
      'TestRealm',
    );
    await db.commitVaultOutcome({
      ...outcome,
      claims: [
        outcome.claims[0],
        { ...outcome.claims[0], characterId: 43, recipientName: 'Guest', guestCycle: 'c1' },
      ],
    });
    const readsCharacters = statements.filter((text) => /\bFROM characters\b/.test(text));
    expect(readsCharacters).toHaveLength(1);
    const placeholders = readsCharacters[0].match(/\$\d+(::\w+)?/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.filter((p) => !p.includes('::'))).toEqual([]);
    expect(readsCharacters[0]).toContain('WHERE id = $2::bigint');
  });
});
