// King of the Hill on the maps: the thin canvas painter over hill_map_view.ts.
// The zone-map and continent-map painters resolve their colour tables once per
// redraw and hand the hill's slice here; this module only draws (the circle,
// the badge and its pennant glyph) and words the caption. No getComputedStyle,
// no canvas text API: each host painter draws the caption through its own text
// path (the zone map's TextSpriteCache, the continent map's outlined fillText
// like its zone labels).

import { durationText } from '../../duration_text';
import { t } from '../../i18n';
import { type HillMapTone, hillMapTone, type MapHillMarker } from './hill_map_view';

/** The hill's colour slice of a map painter's resolved token table. */
export interface HillMapColors {
  unheld: string;
  yours: string;
  others: string;
  areaFill: string;
  outline: string;
  glyph: string;
}

/** The announced circle's dash, in canvas pixels (the risen one is solid). */
const WARNING_DASH: readonly number[] = [6, 4];
const NO_DASH: readonly number[] = [];
const AREA_LINE_WIDTH = 2;
// The pennant inside the badge, as fractions of the badge radius.
const POLE_X_RATIO = -0.28;
const POLE_TOP_RATIO = -0.55;
const POLE_BOTTOM_RATIO = 0.55;
const POLE_WIDTH_RATIO = 0.16;
const FLAG_TIP_X_RATIO = 0.5;
const FLAG_MID_Y_RATIO = -0.28;
const FLAG_FOOT_Y_RATIO = 0;

function toneColor(tone: HillMapTone, colors: HillMapColors): string {
  if (tone === 'yours') return colors.yours;
  if (tone === 'others') return colors.others;
  return colors.unheld;
}

/** The circle at its true size: a faint wash under a holder-coloured rim,
 *  dashed while the hill is only announced. Drawn under the map's markers. */
export function paintHillMapArea(
  ctx: CanvasRenderingContext2D,
  marker: MapHillMarker,
  colors: HillMapColors,
): void {
  if (marker.radius <= 0) return;
  ctx.fillStyle = colors.areaFill;
  ctx.strokeStyle = toneColor(hillMapTone(marker), colors);
  ctx.lineWidth = AREA_LINE_WIDTH;
  ctx.setLineDash(marker.phase === 'warning' ? WARNING_DASH : NO_DASH);
  ctx.beginPath();
  ctx.arc(marker.mx, marker.my, marker.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
}

/** The badge at the hill's centre: a holder-coloured disc with a pennant on a
 *  pole, the same identity at every zoom and on both map levels. */
export function paintHillMapBadge(
  ctx: CanvasRenderingContext2D,
  marker: MapHillMarker,
  colors: HillMapColors,
  radius: number,
  lineWidth: number,
): void {
  const { mx, my } = marker;
  ctx.fillStyle = toneColor(hillMapTone(marker), colors);
  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(mx, my, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const poleX = mx + radius * POLE_X_RATIO;
  const poleWidth = Math.max(1, radius * POLE_WIDTH_RATIO);
  ctx.fillStyle = colors.glyph;
  ctx.fillRect(
    poleX - poleWidth / 2,
    my + radius * POLE_TOP_RATIO,
    poleWidth,
    radius * (POLE_BOTTOM_RATIO - POLE_TOP_RATIO),
  );
  ctx.beginPath();
  ctx.moveTo(poleX, my + radius * POLE_TOP_RATIO);
  ctx.lineTo(mx + radius * FLAG_TIP_X_RATIO, my + radius * FLAG_MID_Y_RATIO);
  ctx.lineTo(poleX, my + radius * FLAG_FOOT_Y_RATIO);
  ctx.closePath();
  ctx.fill();
}

/** The caption beside the badge: the event's name, then when it rises or
 *  falls, as the locale's own duration phrase. */
export function hillMapCaption(marker: Pick<MapHillMarker, 'phase' | 'minutesLeft'>): {
  title: string;
  when: string;
} {
  const minutes = durationText(marker.minutesLeft * 60);
  return {
    title: t('hudChrome.hill.title'),
    when:
      marker.phase === 'warning'
        ? t('hudChrome.hill.rises', { minutes })
        : t('hudChrome.hill.falls', { minutes }),
  };
}
