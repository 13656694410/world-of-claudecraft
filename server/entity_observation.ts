import type { Sim } from '../src/sim/sim';
import { stealthDetectionRadius } from '../src/sim/threat';
import type { Entity } from '../src/sim/types';
import { vaultPortalVisibleToPlayer } from '../src/sim/vault_visibility';
import { INTEREST_RADIUS, isStealthed } from './interest_policy';

/** Viewer-specific admission, re-evaluated even for already-known entities. */
export function canObserveEntity(sim: Sim, viewer: Entity, entity: Entity, d2: number): boolean {
  if (entity.vaultOwnerPid !== undefined && !vaultPortalVisibleToPlayer(sim.ctx, entity, viewer.id))
    return false;
  if (entity.kind !== 'player' || !isStealthed(entity)) return true;
  if (sim.isHostileTo(viewer, entity)) return false;
  const party = sim.partyOf(viewer.id);
  const sameParty = party?.members.includes(entity.id) ?? false;
  const duel = sim.duelFor(viewer.id);
  const duelingEachOther = duel !== null && (duel.a === entity.id || duel.b === entity.id);
  if (sameParty && !duelingEachOther) return true;
  const radius = stealthDetectionRadius(viewer, entity, INTEREST_RADIUS);
  return d2 <= radius * radius;
}
