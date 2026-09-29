// King of the Hill on the maps: the pure projection of IWorld.hillInfo onto
// the zone map (the circle at its true size, with a badge at its centre) and
// the continent overview (a badge where the hill stands). Every viewer gets the
// hill's zone, centre, radius, phase and holder from `hillInfoFor` wherever
// they stand (src/sim/pvp/hill.ts), so both levels show it realm-wide: the
// continent map always, the zone map whenever the hill's zone is the one on
// screen. DOM-free and i18n-free (registered in UI_PURE_CORES); the painters
// resolve the colours and the localized caption.

import type { HillInfo, HillPhaseInfo, HillSide } from '../../../world_api';

type Project = (x: number, z: number) => { mx: number; my: number };

/** The hill as either map draws it, in canvas pixels. */
export interface MapHillMarker {
  mx: number;
  my: number;
  /** The circle's radius in canvas pixels at this zoom (0 on the continent
   *  map, where the circle is smaller than the badge). */
  radius: number;
  /** Announced (drawn faint and dashed) or risen. */
  phase: HillPhaseInfo;
  /** Who holds it from this viewer's seat: the badge and ring colour. */
  holder: HillSide;
  /** Minutes until it rises (announced) or falls (risen), for the caption. */
  minutesLeft: number;
}

function marker(info: HillInfo, project: Project, radius: number): MapHillMarker {
  const { mx, my } = project(info.x, info.z);
  return {
    mx,
    my,
    radius,
    phase: info.phase,
    holder: info.holder,
    minutesLeft: info.minutesLeft,
  };
}

/**
 * The zone-map marker, or null when no hill is announced or standing, when it
 * stands in another zone than the one on screen, or when its centre is out of
 * the zoomed view. `pxPerYard` converts the circle's radius at this zoom.
 */
export function buildZoneMapHillMarker(
  info: HillInfo | null | undefined,
  zoneId: string,
  inView: (x: number, z: number) => boolean,
  project: Project,
  pxPerYard: number,
): MapHillMarker | null {
  if (!info || info.zoneId !== zoneId || !inView(info.x, info.z)) return null;
  return marker(info, project, Math.max(0, info.radius * pxPerYard));
}

/** The continent-map marker, or null when no hill is announced or standing
 *  (or, defensively, when its centre is off the world rect). Not gated on the
 *  viewer's zone: telling the realm where the hill is, is the point. */
export function buildContinentHillMarker(
  info: HillInfo | null | undefined,
  inWorld: (x: number, z: number) => boolean,
  project: Project,
): MapHillMarker | null {
  if (!info || !inWorld(info.x, info.z)) return null;
  return marker(info, project, 0);
}

/** The colour role a marker paints in: the renderer's ring rule
 *  (src/render/hill_ring_core.ts hillRingColor), announced hills unheld. */
export type HillMapTone = 'unheld' | 'yours' | 'others';

export function hillMapTone(m: Pick<MapHillMarker, 'phase' | 'holder'>): HillMapTone {
  if (m.phase === 'warning') return 'unheld';
  if (m.holder === 'you') return 'yours';
  if (m.holder === 'other') return 'others';
  return 'unheld';
}
