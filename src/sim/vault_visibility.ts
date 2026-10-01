import type { Entity } from './types';

/** Current party only. Prior admission/reward entitlement does not grant visibility. */
export function vaultPortalVisible(
  portal: Pick<Entity, 'vaultOwnerPid' | 'vaultOwnerCharacterId'>,
  viewerPid: number,
  party: readonly (number | { pid: number })[] | null,
  characterIdFor?: (pid: number) => number | undefined,
): boolean {
  if (portal.vaultOwnerPid === undefined) return true;
  const isOwner = (pid: number): boolean =>
    portal.vaultOwnerCharacterId !== undefined && characterIdFor
      ? characterIdFor(pid) === portal.vaultOwnerCharacterId
      : pid === portal.vaultOwnerPid;
  return (
    isOwner(viewerPid) ||
    (party?.some((member) => isOwner(typeof member === 'number' ? member : member.pid)) ?? false)
  );
}
