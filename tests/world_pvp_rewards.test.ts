import { describe, expect, it } from 'vitest';
import { grantXp } from '../src/sim/combat/damage';
import { BUILTIN_WORLD } from '../src/sim/data';
import { awardFactionReputation, maxStandingForLevel } from '../src/sim/factions';
import {
  sanitizeWorldPvpRewardTicks,
  WORLD_PVP_MAX_REWARD_TICKS,
  WORLD_PVP_TITLE_THRESHOLDS,
} from '../src/sim/pvp/world_pvp_rewards_rules';
import { Sim } from '../src/sim/sim';
import { TICK_RATE } from '../src/sim/types';

function fixture() {
  const sim = new Sim({
    seed: 7,
    playerClass: 'warrior',
    noPlayer: true,
    world: { ...BUILTIN_WORLD, camps: [], npcs: {}, groundObjects: [] },
  });
  const pid = sim.addPlayer('warrior', 'Flagbearer');
  sim.setPlayerLevel(20, pid);
  const meta = sim.players.get(pid)!;
  return { sim, pid, meta };
}

describe('World PvP rewards', () => {
  it('adds 20% to all XP and positive reputation, respecting reputation caps', () => {
    const { sim, pid, meta } = fixture();
    const before = meta.lifetimeXp;
    grantXp(sim.ctx, 100, meta);
    expect(meta.lifetimeXp - before).toBe(100);
    expect(awardFactionReputation(meta, 'rift_watch', 100, 20).gained).toBe(100);
    sim.setWorldPvpFlag(true, pid);
    grantXp(sim.ctx, 100, meta);
    grantXp(sim.ctx, 100, meta, { fromKill: true });
    expect(meta.lifetimeXp - before).toBe(340);
    expect(awardFactionReputation(meta, 'rift_watch', 100, 20).gained).toBe(120);
    expect(awardFactionReputation(meta, 'rift_watch', 0, 20).gained).toBe(0);
    expect(awardFactionReputation(meta, 'rift_watch', -10, 20).gained).toBe(0);
    meta.factions!.rift_watch = maxStandingForLevel(20) - 50;
    expect(awardFactionReputation(meta, 'rift_watch', 100, 20).gained).toBe(50);
  });

  it('applies before rested kill XP and keeps the same total in XP events', () => {
    const { sim, pid, meta } = fixture();
    sim.setPlayerLevel(10, pid);
    sim.setWorldPvpFlag(true, pid);
    meta.restedXp = 1000;
    sim.events.length = 0;
    grantXp(sim.ctx, 100, meta, { fromKill: true });
    expect(meta.restedXp).toBe(880);
    expect(sim.events.find((e) => e.type === 'xp')).toMatchObject({ amount: 240, rested: 120 });
    grantXp(sim.ctx, 101, meta);
    expect(sim.events.filter((e) => e.type === 'xp').at(-1)).toMatchObject({ amount: 121 });
  });

  it.each(WORLD_PVP_TITLE_THRESHOLDS)(
    'grants $id exactly at $hours played hours and never repeats',
    ({ id, hours }) => {
      const { sim, pid, meta } = fixture();
      sim.setWorldPvpFlag(true, pid);
      meta.worldPvp!.rewardTicks = hours * 3600 * TICK_RATE - 2;
      sim.tick();
      expect(meta.deedsEarned.has(id)).toBe(false);
      const events = sim.tick();
      expect(meta.deedsEarned.has(id)).toBe(true);
      expect(events.filter((e) => e.type === 'deedUnlocked' && e.deedId === id)).toHaveLength(1);
      meta.worldPvp!.rewardTicks = hours * 3600 * TICK_RATE - 1;
      expect(sim.tick().filter((e) => e.type === 'deedUnlocked' && e.deedId === id)).toHaveLength(
        0,
      );
      const saved = sim.serializeCharacter(pid)!;
      sim.removePlayer(pid);
      const other = fixture().sim;
      const restoredPid = other.addPlayer('warrior', 'Flagbearer', { state: saved });
      expect(other.players.get(restoredPid)!.deedsEarned.has(id)).toBe(true);
    },
  );

  it('preserves fractional played seconds across logout without counting time away', () => {
    const { sim, pid, meta } = fixture();
    sim.setWorldPvpFlag(true, pid);
    for (let tick = 0; tick < 23; tick++) sim.tick();
    expect(meta.worldPvp!.rewardTicks).toBe(23);
    const saved = sim.serializeCharacter(pid)!;
    sim.removePlayer(pid);
    const other = fixture().sim;
    other.time = 900_000;
    const restoredPid = other.addPlayer('warrior', 'Flagbearer', { state: saved });
    const restored = other.players.get(restoredPid)!;
    expect(restored.worldPvp!.rewardTicks).toBe(23);
    other.tick();
    expect(restored.worldPvp!.rewardTicks).toBe(24);
    expect(other.serializeCharacter(restoredPid)!.worldPvp!.rewardTicks).toBe(24);
  });

  it('stops progress for a leaving character and caps the counter at seven days', () => {
    const { sim, pid, meta } = fixture();
    sim.setWorldPvpFlag(true, pid);
    meta.leaving = true;
    sim.tick();
    expect(meta.worldPvp!.rewardTicks ?? 0).toBe(0);
    meta.leaving = false;
    meta.worldPvp!.rewardTicks = WORLD_PVP_MAX_REWARD_TICKS;
    sim.tick();
    expect(meta.worldPvp!.rewardTicks).toBe(WORLD_PVP_MAX_REWARD_TICKS);
  });

  it('resets on an accepted off request, stops bonuses during disarm, and starts fresh if cancelled', () => {
    const { sim, pid, meta } = fixture();
    sim.setWorldPvpFlag(true, pid);
    meta.worldPvp!.rewardTicks = 3600 * TICK_RATE - 1;
    sim.tick();
    sim.time += 10;
    sim.setWorldPvpFlag(false, pid);
    expect(meta.worldPvp!.flagged).toBe(true);
    expect(meta.worldPvp!.rewardTicks).toBe(0);
    const before = meta.lifetimeXp;
    grantXp(sim.ctx, 100, meta);
    expect(meta.lifetimeXp - before).toBe(100);
    expect(awardFactionReputation(meta, 'rift_watch', 100, 20).gained).toBe(100);
    sim.tick();
    expect(meta.worldPvp!.rewardTicks).toBe(0);
    const saved = sim.serializeCharacter(pid)!;
    const other = fixture().sim;
    const restoredPid = other.addPlayer('warrior', 'Flagbearer', { state: saved });
    expect(other.players.get(restoredPid)!.worldPvp!.disarmAt).not.toBeNull();
    sim.time += 10;
    sim.setWorldPvpFlag(true, pid);
    sim.tick();
    expect(meta.worldPvp!.rewardTicks).toBe(1);
    expect(meta.deedsEarned.has('pvp_flag_1h')).toBe(true);
  });

  it('normalizes legacy and malformed saves, and disabled realms restore no rewards', () => {
    const { sim, pid } = fixture();
    sim.setWorldPvpFlag(true, pid);
    const saved = sim.serializeCharacter(pid)!;
    for (const rewardTicks of [undefined, NaN, Infinity, -1, '100']) {
      const restoredPid = sim.addPlayer('warrior', 'Legacy', {
        state: { ...saved, worldPvp: { flagged: true, rewardTicks: rewardTicks as number } },
      });
      expect(sim.players.get(restoredPid)!.worldPvp!.rewardTicks ?? 0).toBe(0);
    }
    expect(sanitizeWorldPvpRewardTicks(12.8)).toBe(12);
    expect(sanitizeWorldPvpRewardTicks(Number.MAX_SAFE_INTEGER)).toBe(WORLD_PVP_MAX_REWARD_TICKS);
    const disabled = new Sim({
      seed: 7,
      playerClass: 'warrior',
      noPlayer: true,
      worldPvpDisabled: true,
    });
    const restoredPid = disabled.addPlayer('warrior', 'Disabled', { state: saved });
    const meta = disabled.players.get(restoredPid)!;
    const before = meta.lifetimeXp;
    grantXp(disabled.ctx, 100, meta);
    expect(meta.lifetimeXp - before).toBe(100);
    expect(awardFactionReputation(meta, 'rift_watch', 100, 20).gained).toBe(100);
    expect(meta.worldPvp?.rewardTicks ?? 0).toBe(0);
  });
});
