// One bounded counter per connected character, driven only by simulation ticks.
import type { SimContext } from '../sim_context';
import { TICK_RATE } from '../types';
import {
  WORLD_PVP_MAX_REWARD_TICKS,
  WORLD_PVP_TITLE_THRESHOLDS,
  worldPvpRewardsActive,
} from './world_pvp_rewards_rules';
import { worldPvpZonePolicyAt } from './world_pvp_zones';

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
    if (worldPvpZonePolicyAt(player.pos.x, player.pos.z) === 'sanctuary') continue;
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
