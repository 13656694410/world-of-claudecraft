// King of the Hill on the maps (src/ui/hud/hill/hill_map_view.ts, the pure
// projection; hill_map_painter.ts, the thin canvas painter): the zone map
// draws the circle at its true size when the hill's zone is framed, the
// continent map badges it from anywhere, the colour follows the renderer's
// ring rule, an announced circle is dashed, and the caption says when it
// rises or falls.
import { afterEach, describe, expect, it } from 'vitest';
import {
  hillMapCaption,
  paintHillMapArea,
  paintHillMapBadge,
} from '../src/ui/hud/hill/hill_map_painter';
import {
  buildContinentHillMarker,
  buildZoneMapHillMarker,
  hillMapTone,
  type MapHillMarker,
} from '../src/ui/hud/hill/hill_map_view';
import { setLanguage } from '../src/ui/i18n';
import type { HillInfo } from '../src/world_api';

function info(over: Partial<HillInfo> = {}): HillInfo {
  return {
    zoneId: 'drakelands',
    x: 100,
    z: 400,
    radius: 50,
    phase: 'active',
    minutesLeft: 12,
    inZone: false,
    standing: 'counted',
    holder: 'none',
    inside: false,
    holderCount: 0,
    yourCount: 0,
    challenger: 'none',
    challengerCount: 0,
    contest: 0,
    ...over,
  };
}

const project = (x: number, z: number) => ({ mx: x * 2, my: z * 3 });
const everywhere = () => true;

describe('buildZoneMapHillMarker', () => {
  it('projects the centre and scales the radius on the hill zone map', () => {
    expect(buildZoneMapHillMarker(info(), 'drakelands', everywhere, project, 1.5)).toEqual({
      mx: 200,
      my: 1200,
      radius: 75,
      phase: 'active',
      holder: 'none',
      minutesLeft: 12,
    });
  });

  it('is null with no hill, on another zone map, or with the centre out of view', () => {
    expect(buildZoneMapHillMarker(null, 'drakelands', everywhere, project, 1)).toBeNull();
    expect(buildZoneMapHillMarker(undefined, 'drakelands', everywhere, project, 1)).toBeNull();
    expect(buildZoneMapHillMarker(info(), 'frostveil', everywhere, project, 1)).toBeNull();
    const seen: Array<[number, number]> = [];
    const nowhere = (x: number, z: number) => {
      seen.push([x, z]);
      return false;
    };
    expect(buildZoneMapHillMarker(info(), 'drakelands', nowhere, project, 1)).toBeNull();
    expect(seen).toEqual([[100, 400]]);
  });
});

describe('buildContinentHillMarker', () => {
  it('badges the hill wherever the viewer stands, with no ring at this scale', () => {
    expect(
      buildContinentHillMarker(info({ phase: 'warning', minutesLeft: 3 }), everywhere, project),
    ).toEqual({
      mx: 200,
      my: 1200,
      radius: 0,
      phase: 'warning',
      holder: 'none',
      minutesLeft: 3,
    });
  });

  it('is null with no hill, or off the world rect', () => {
    expect(buildContinentHillMarker(null, everywhere, project)).toBeNull();
    expect(buildContinentHillMarker(info(), () => false, project)).toBeNull();
  });
});

describe('hillMapTone', () => {
  it('follows the ring rule: announced and unheld gold, yours green, theirs red', () => {
    expect(hillMapTone({ phase: 'warning', holder: 'you' })).toBe('unheld');
    expect(hillMapTone({ phase: 'active', holder: 'none' })).toBe('unheld');
    expect(hillMapTone({ phase: 'active', holder: 'you' })).toBe('yours');
    expect(hillMapTone({ phase: 'active', holder: 'other' })).toBe('others');
  });
});

/** A recording 2D context: every fill and stroke with the style it used. */
function recorder() {
  const ops: string[] = [];
  let dash: number[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    setLineDash(d: number[]) {
      dash = [...d];
    },
    beginPath() {},
    arc(x: number, y: number, r: number) {
      ops.push(`arc:${x},${y},${r}`);
    },
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      ops.push(`fill:${ctx.fillStyle}`);
    },
    stroke() {
      ops.push(`stroke:${ctx.strokeStyle}:dash=${dash.join('/')}`);
    },
    fillRect() {
      ops.push(`fillRect:${ctx.fillStyle}`);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, dash: () => dash };
}

const COLORS = {
  unheld: 'gold',
  yours: 'green',
  others: 'red',
  areaFill: 'wash',
  outline: 'ink',
  glyph: 'glyph',
};

function marker(over: Partial<MapHillMarker> = {}): MapHillMarker {
  return { mx: 10, my: 20, radius: 30, phase: 'active', holder: 'other', minutesLeft: 12, ...over };
}

describe('paintHillMapArea', () => {
  it('washes the circle and rims it in the holder colour, solid once risen', () => {
    const { ctx, ops, dash } = recorder();
    paintHillMapArea(ctx, marker(), COLORS);
    expect(ops).toEqual(['arc:10,20,30', 'fill:wash', 'stroke:red:dash=']);
    expect(dash()).toEqual([]);
  });

  it('dashes the announced circle in gold, and resets the dash after', () => {
    const { ctx, ops, dash } = recorder();
    paintHillMapArea(ctx, marker({ phase: 'warning', holder: 'you' }), COLORS);
    expect(ops).toEqual(['arc:10,20,30', 'fill:wash', 'stroke:gold:dash=6/4']);
    expect(dash()).toEqual([]);
  });

  it('draws no ring at a zero radius (the continent scale)', () => {
    const { ctx, ops } = recorder();
    paintHillMapArea(ctx, marker({ radius: 0 }), COLORS);
    expect(ops).toEqual([]);
  });
});

describe('paintHillMapBadge', () => {
  it('fills a holder-coloured, outlined disc and a pennant glyph over it', () => {
    const { ctx, ops } = recorder();
    paintHillMapBadge(ctx, marker({ holder: 'you' }), COLORS, 11, 2);
    expect(ops).toEqual([
      'arc:10,20,11',
      'fill:green',
      'stroke:ink:dash=',
      'fillRect:glyph',
      'fill:glyph',
    ]);
  });
});

describe('hillMapCaption', () => {
  afterEach(() => setLanguage('en'));

  it('names the event and says when it rises or falls, in the locale duration phrase', () => {
    setLanguage('en');
    expect(hillMapCaption({ phase: 'active', minutesLeft: 12 })).toEqual({
      title: 'King of the Hill',
      when: 'Falls in 12 minutes',
    });
    expect(hillMapCaption({ phase: 'warning', minutesLeft: 1 })).toEqual({
      title: 'King of the Hill',
      when: 'Rises in 1 minute',
    });
  });
});
