// Active hoards follow their summoner's current party. Finished reward rosters
// are immutable so party changes cannot rewrite an outcome awaiting persistence.
import type { SimContext } from '../sim_context';
import type { RiftInstance } from './types';

export function hoardOwnerPid(
  ctx: SimContext,
  ownerPid: number,
  ownerCharacterId?: number,
): number | undefined {
  if (ownerCharacterId === undefined) return ctx.players.has(ownerPid) ? ownerPid : undefined;
  return [...ctx.players.values()].find((meta) => meta.characterId === ownerCharacterId)?.entityId;
}

/** Reclaim departed guests' slots before admission and before freezing rewards. */
export function reconcileHoardParty(
  ctx: SimContext,
  inst: RiftInstance,
  evict: (pid: number) => void,
): void {
  const vault = inst.vault;
  if (!vault || inst.outcome !== 'active') return;
  const owner = hoardOwnerPid(ctx, vault.ownerPid, vault.ownerCharacterId);
  // A disconnected owner cannot admit guests. The existing group can still
  // finish and retain its bounded reward roster while the owner is offline.
  if (owner === undefined) return;
  vault.ownerPid = owner;
  const allowed = new Set(ctx.partyOf(owner)?.members ?? [owner]);
  allowed.add(owner);
  for (const pid of inst.memberIds) {
    if (allowed.has(pid)) continue;
    evict(pid);
    inst.memberIds.delete(pid);
    vault.memberCharacterIds?.delete(pid);
  }
  const characters = new Set([...allowed].map((pid) => ctx.players.get(pid)?.characterId));
  if (vault.ownerCharacterId !== undefined) characters.add(vault.ownerCharacterId);
  for (const id of vault.entrantSnapshots?.keys() ?? []) {
    if (!characters.has(id)) vault.entrantSnapshots?.delete(id);
  }
}

/** The owner always occupies one of the five reward slots, even outside the room. */
export function hoardRosterFull(inst: RiftInstance, pid: number, characterId?: number): boolean {
  const vault = inst.vault;
  if (
    !vault ||
    inst.memberIds.has(pid) ||
    pid === vault.ownerPid ||
    (characterId !== undefined &&
      (characterId === vault.ownerCharacterId || vault.entrantSnapshots?.has(characterId)))
  )
    return false;
  const members = inst.memberIds.size + (inst.memberIds.has(vault.ownerPid) ? 0 : 1);
  return Math.max(members, vault.entrantSnapshots?.size ?? 0) >= 5;
}
