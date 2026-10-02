// One bounded counter per connected character, driven only by simulation ticks.
import { DUNGEON_X_THRESHOLD } from '../data';
import type { SimContext } from '../sim_context';
import { TICK_RATE } from '../types';
import {
  WORLD_PVP_MAX_REWARD_TICKS,
  WORLD_PVP_TITLE_THRESHOLDS,
  worldPvpRewardsActive,
} from './world_pvp_rewards_rules';
import type { WorldPvpZonePolicy } from './world_pvp_rules';
import { worldPvpZonePolicyAt } from './world_pvp_zones';

/** Does a flagged player standing at world x, on ground of this zone policy,
 *  bank streak time? Only on open-world ground another flagged player can
 *  reach. Every instance (dungeon, raid, delve, rift, maze, arena,
 *  battleground) sits on the far-east plane past DUNGEON_X_THRESHOLD, the same
 *  line Vitality reads (vitality.ts), and a sanctuary has no world PvP at all.
 *  Without the plane check a flagged player could park inside a private
 *  dungeon copy, out of every rival's reach, and bank the titles risk-free. */
export function worldPvpRewardsTickOn(x: number, zone: WorldPvpZonePolicy): boolean {
  return x <= DUNGEON_X_THRESHOLD && zone !== 'sanctuary';
}

/** The same verdict read off the ground at (x, z). The plane check runs first
 *  so a player inside an instance never pays the zone rectangle scan. */
export function worldPvpRewardsTickAt(x: number, z: number): boolean {
  return x <= DUNGEON_X_THRESHOLD && worldPvpRewardsTickOn(x, worldPvpZonePolicyAt(x, z));
}

export function updateWorldPvpRewards(ctx: SimContext): void {
  if (ctx.worldPvpDisabled) return;
  for (const meta of ctx.players.values()) {
    const state = meta.worldPvp;
    if (
      !state ||
      !worldPvpRewardsActive(state) ||
      meta.leaving ||
      !ctx.entities.has(meta.entityId) ||
      ctx.entities.get(meta.entityId)!.pvpRewardsPaused
    )
      continue;
    const player = ctx.entities.get(meta.entityId)!;
    if (!worldPvpRewardsTickAt(player.pos.x, player.pos.z)) continue;
    const before = state.rewardTicks ?? 0;
    if (before >= WORLD_PVP_MAX_REWARD_TICKS) continue;
    const ticks = before + 1;
    state.rewardTicks = ticks;
    if (ticks % TICK_RATE !== 0) continue;
    // Only five threshold ticks ever enter the grant path. Re-earned titles
    // use the ordinary idempotent deed grant, so they emit no extra saves.
    for (const title of WORLD_PVP_TITLE_THRESHOLDS) {
      if (ticks === title.hours * 3600 * TICK_RATE) ctx.grantDeed(meta, title.id);
    }
  }
}
