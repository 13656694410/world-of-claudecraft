import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendEnabledFeatures,
  ENABLE_FEATURES_SWITCH,
  featureName,
  mergeFeatureList,
} from '../electron/chromium_features.cjs';
import { defaultDesktopPrefs, sanitizeDesktopPrefs } from '../electron/desktop_prefs.cjs';
import {
  applyGpuBackendSwitches,
  decideGpuBackendLaunch,
  GPU_BACKEND_RESCUE_ENV,
  GPU_BACKEND_RUNGS,
  type GpuBackendLaunch,
} from '../electron/gpu_backend.cjs';
import {
  applyShaderDiskCacheSwitches,
  decideShaderDiskCache,
  GPU_DISK_CACHE_SIZE_KB,
  GPU_DISK_CACHE_SIZE_SWITCH,
  SHADER_DISK_CACHE_DISABLE_ENV,
  SHADER_DISK_CACHE_FEATURE,
  SHADER_DISK_CACHE_PLATFORMS,
} from '../electron/shader_disk_cache.cjs';
import { stripComments } from './helpers/strip_comments';

const FEATURE = 'ANGLEPerContextBlobCache';
const VULKAN_FEATURES = ['Vulkan', 'DefaultANGLEVulkan', 'VulkanFromANGLE'];
const AMD_CARD_SWITCHES = [['disable-angle-features', 'supportsImageDrmFormatModifier']] as const;

/**
 * A command line with Chromium's semantics: one value per switch name, a later append
 * REPLACES the earlier value (base::CommandLine keeps a map), while every append is still
 * recorded so a test can see how many times a switch was written. Seeded with what the
 * player's own argv carried.
 */
function chromiumCommandLine(argv: Record<string, string> = {}) {
  const values = new Map(Object.entries(argv));
  const appends: Array<[string, string]> = [];
  return {
    values,
    appends,
    app: {
      commandLine: {
        appendSwitch(name: string, value = '') {
          values.set(name, value);
          appends.push([name, value]);
        },
        getSwitchValue: (name: string) => values.get(name) ?? '',
        hasSwitch: (name: string) => values.has(name),
      },
    },
  };
}

const featuresOf = (value: string | undefined) =>
  (value ?? '').split(',').filter((entry) => entry !== '');
const occurrences = (list: string[], name: string) =>
  list.filter((entry) => featureName(entry) === name).length;

/** The real launch decisions for every rung the shell can run, on each platform. */
function everyLaunch(): Array<{ what: string; platform: string; launch: GpuBackendLaunch }> {
  const out: Array<{ what: string; platform: string; launch: GpuBackendLaunch }> = [];
  for (const platform of ['win32', 'linux']) {
    out.push({
      what: `${platform} auto`,
      platform,
      launch: decideGpuBackendLaunch({ platform, env: {}, prefs: defaultDesktopPrefs() }),
    });
  }
  for (const rung of GPU_BACKEND_RUNGS) {
    out.push({
      what: `linux rescued to ${rung}`,
      platform: 'linux',
      launch: decideGpuBackendLaunch({
        platform: 'linux',
        env: { [GPU_BACKEND_RESCUE_ENV]: rung },
        prefs: defaultDesktopPrefs(),
      }),
    });
  }
  for (const gpuBackend of ['vulkan', 'opengl'] as const) {
    out.push({
      what: `linux setting ${gpuBackend}`,
      platform: 'linux',
      launch: decideGpuBackendLaunch({
        platform: 'linux',
        env: {},
        prefs: { ...defaultDesktopPrefs(), gpuBackend },
      }),
    });
  }
  return out;
}

describe('the switches (load-bearing literals)', () => {
  it('names the Chromium feature, the size switch and the size exactly', () => {
    // Chromium matches feature and switch names exactly and ignores unknown ones, so a typo
    // ships a client that silently keeps recompiling every shader each session.
    expect(SHADER_DISK_CACHE_FEATURE).toBe(FEATURE);
    expect(GPU_DISK_CACHE_SIZE_SWITCH).toBe('gpu-disk-cache-size-kb');
    // 64 MB: several Ultra tours (about 7 to 8 MB of entries each), without the RAM and
    // startup read of a cache the GPU process loads whole.
    expect(GPU_DISK_CACHE_SIZE_KB).toBe(65536);
    expect(ENABLE_FEATURES_SWITCH).toBe('enable-features');
    expect(SHADER_DISK_CACHE_DISABLE_ENV).toBe('WOC_DISABLE_SHADER_DISK_CACHE');
  });

  it('is scoped to the two measured desktop platforms', () => {
    expect([...SHADER_DISK_CACHE_PLATFORMS].sort()).toEqual(['linux', 'win32']);
  });
});

describe('mergeFeatureList', () => {
  it('appends to an empty or absent list', () => {
    expect(mergeFeatureList('', [FEATURE])).toBe(FEATURE);
    expect(mergeFeatureList(undefined, [FEATURE])).toBe(FEATURE);
    expect(mergeFeatureList(null, [FEATURE])).toBe(FEATURE);
  });

  it('keeps the existing entries first and in order', () => {
    expect(mergeFeatureList('Vulkan,DefaultANGLEVulkan', [FEATURE])).toBe(
      `Vulkan,DefaultANGLEVulkan,${FEATURE}`,
    );
  });

  it('never lists a feature twice, whatever entry form already names it', () => {
    expect(mergeFeatureList(FEATURE, [FEATURE])).toBe(FEATURE);
    expect(mergeFeatureList(`*${FEATURE}`, [FEATURE])).toBe(`*${FEATURE}`);
    expect(mergeFeatureList(`${FEATURE}<Trial`, [FEATURE])).toBe(`${FEATURE}<Trial`);
    expect(mergeFeatureList(`${FEATURE}:a/b`, [FEATURE])).toBe(`${FEATURE}:a/b`);
    expect(mergeFeatureList('A,A', ['A'])).toBe('A');
  });

  it('drops empty and padded entries', () => {
    expect(mergeFeatureList(' A ,, B,', [' C'])).toBe('A,B,C');
  });
});

describe('appendEnabledFeatures', () => {
  it('writes the merged list as the one value, never replacing what was there', () => {
    const cl = chromiumCommandLine({ 'enable-features': 'PlayerFeature' });
    expect(appendEnabledFeatures(cl.app.commandLine, [FEATURE])).toBe(`PlayerFeature,${FEATURE}`);
    expect(cl.values.get('enable-features')).toBe(`PlayerFeature,${FEATURE}`);
  });

  it('works on a command line without getSwitchValue (the older test fakes)', () => {
    const appends: Array<[string, string]> = [];
    appendEnabledFeatures({ appendSwitch: (n, v) => appends.push([n, v]) }, ['A', 'B']);
    expect(appends).toEqual([['enable-features', 'A,B']]);
  });

  it('appends nothing when there is nothing to enable', () => {
    const cl = chromiumCommandLine();
    appendEnabledFeatures(cl.app.commandLine, []);
    expect(cl.appends).toEqual([]);
  });
});

describe('decideShaderDiskCache', () => {
  it('is on by default on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      expect(decideShaderDiskCache({ platform, env: {}, prefs: defaultDesktopPrefs() })).toEqual({
        enabled: true,
        reason: 'default',
      });
    }
  });

  it('is off on macOS, where it was never measured', () => {
    const decision = decideShaderDiskCache({ platform: 'darwin', env: {}, prefs: null });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('platform darwin');
  });

  it('honors each off switch on its own', () => {
    const on = { platform: 'win32', env: {}, prefs: defaultDesktopPrefs() };
    const cases = [
      { env: { WOC_DISABLE_SHADER_DISK_CACHE: '1' }, reason: 'WOC_DISABLE_SHADER_DISK_CACHE=1' },
      { env: { WOC_DISABLE_GPU_FORCE: '1' }, reason: 'WOC_DISABLE_GPU_FORCE=1' },
      {
        prefs: { ...defaultDesktopPrefs(), shaderDiskCacheOptOut: true },
        reason: 'setting shaderDiskCacheOptOut',
      },
    ];
    for (const { reason, ...input } of cases) {
      expect(decideShaderDiskCache({ ...on, ...input })).toEqual({ enabled: false, reason });
    }
  });

  it('arms the env switches on a strict 1 only, and the setting on a strict true only', () => {
    for (const value of ['0', 'true', 'yes', ' 1', '']) {
      for (const name of [SHADER_DISK_CACHE_DISABLE_ENV, 'WOC_DISABLE_GPU_FORCE']) {
        expect(
          decideShaderDiskCache({ platform: 'win32', env: { [name]: value }, prefs: null }).enabled,
          `${name}=${JSON.stringify(value)}`,
        ).toBe(true);
      }
    }
    for (const value of ['true', 1, 'yes'] as const) {
      expect(
        decideShaderDiskCache({
          platform: 'win32',
          env: {},
          prefs: { shaderDiskCacheOptOut: value as never },
        }).enabled,
      ).toBe(true);
    }
  });
});

describe('the switches on every rung (both levers applied the way main.cjs applies them)', () => {
  const playerArgvs: Array<[string, Record<string, string>]> = [
    ['no player switch', {}],
    ['a player feature', { 'enable-features': 'PlayerFeature' }],
    ['the feature already on the player command line', { 'enable-features': FEATURE }],
  ];

  for (const { what, platform, launch } of everyLaunch()) {
    for (const [argvWhat, argv] of playerArgvs) {
      for (const cardSwitches of [[], AMD_CARD_SWITCHES]) {
        for (const order of ['backend first', 'cache first'] as const) {
          const label = `${what}, ${argvWhat}, ${cardSwitches.length ? 'AMD card' : 'no card switch'}, ${order}`;
          it(label, () => {
            const cl = chromiumCommandLine(argv);
            const decision = decideShaderDiskCache({
              platform,
              env: {},
              prefs: defaultDesktopPrefs(),
            });
            const backend = () => applyGpuBackendSwitches(cl.app, launch, cardSwitches);
            const cache = () => applyShaderDiskCacheSwitches(cl.app, decision);
            if (order === 'backend first') {
              backend();
              cache();
            } else {
              cache();
              backend();
            }
            const features = featuresOf(cl.values.get('enable-features'));
            expect(occurrences(features, FEATURE), 'the cache feature, exactly once').toBe(1);
            for (const vulkan of VULKAN_FEATURES) {
              expect(occurrences(features, vulkan), `${vulkan} on this launch`).toBe(
                launch.backend === 'vulkan' ? 1 : 0,
              );
            }
            if (argv['enable-features'] === 'PlayerFeature') {
              expect(occurrences(features, 'PlayerFeature'), 'the player feature survives').toBe(1);
            }
            expect(cl.values.get('gpu-disk-cache-size-kb')).toBe('65536');
            // The backend's other switches are untouched by the merge.
            if (launch.backend === 'vulkan') {
              expect(cl.values.get('use-angle')).toBe('vulkan');
              if (cardSwitches.length) {
                expect(cl.values.get('disable-angle-features')).toBe(
                  'supportsImageDrmFormatModifier',
                );
              }
            }
          });
        }
      }
    }
  }
});

describe('the off switches remove both switches', () => {
  const offInputs: Array<[string, Parameters<typeof decideShaderDiskCache>[0]]> = [
    ['the env', { platform: 'win32', env: { WOC_DISABLE_SHADER_DISK_CACHE: '1' }, prefs: null }],
    ['the no-lever rescue env', { platform: 'win32', env: { WOC_DISABLE_GPU_FORCE: '1' } }],
    [
      'the stored opt-out',
      {
        platform: 'win32',
        env: {},
        prefs: { ...defaultDesktopPrefs(), shaderDiskCacheOptOut: true },
      },
    ],
    ['macOS', { platform: 'darwin', env: {}, prefs: null }],
  ];
  for (const [what, input] of offInputs) {
    it(what, () => {
      const cl = chromiumCommandLine();
      applyShaderDiskCacheSwitches(cl.app, decideShaderDiskCache(input));
      expect(cl.appends).toEqual([]);
    });
  }

  it('leaves the Vulkan feature set exactly as the backend wrote it', () => {
    const cl = chromiumCommandLine();
    const launch = decideGpuBackendLaunch({
      platform: 'linux',
      env: {},
      prefs: defaultDesktopPrefs(),
    });
    applyGpuBackendSwitches(cl.app, launch, []);
    applyShaderDiskCacheSwitches(
      cl.app,
      decideShaderDiskCache({
        platform: 'linux',
        env: { WOC_DISABLE_SHADER_DISK_CACHE: '1' },
        prefs: null,
      }),
    );
    expect(cl.values.get('enable-features')).toBe('Vulkan,DefaultANGLEVulkan,VulkanFromANGLE');
    expect(cl.values.has('gpu-disk-cache-size-kb')).toBe(false);
  });

  it('applies nothing for a missing decision', () => {
    const cl = chromiumCommandLine();
    applyShaderDiskCacheSwitches(cl.app, null);
    applyShaderDiskCacheSwitches(cl.app, undefined);
    expect(cl.appends).toEqual([]);
  });
});

describe('a size the player passed on the command line', () => {
  it('is kept, while the feature is still merged in', () => {
    const cl = chromiumCommandLine({ 'gpu-disk-cache-size-kb': '262144' });
    applyShaderDiskCacheSwitches(cl.app, { enabled: true, reason: 'default' });
    expect(cl.values.get('gpu-disk-cache-size-kb')).toBe('262144');
    expect(cl.appends).toEqual([['enable-features', FEATURE]]);
  });
});

describe('the stored opt-out (desktop-prefs.json)', () => {
  it('defaults to off-switch not set', () => {
    expect(defaultDesktopPrefs().shaderDiskCacheOptOut).toBe(false);
  });

  it('survives a sanitize pass, so a hand edit is kept through the shell own saves', () => {
    expect(
      sanitizeDesktopPrefs({ version: 1, shaderDiskCacheOptOut: true }).shaderDiskCacheOptOut,
    ).toBe(true);
    const saved = sanitizeDesktopPrefs({
      ...sanitizeDesktopPrefs({ version: 1, shaderDiskCacheOptOut: true }),
      maximized: true,
    });
    expect(saved.shaderDiskCacheOptOut).toBe(true);
  });

  it('accepts a strict boolean only', () => {
    for (const junk of ['true', 1, 'yes', null, {}]) {
      expect(
        sanitizeDesktopPrefs({ version: 1, shaderDiskCacheOptOut: junk }).shaderDiskCacheOptOut,
      ).toBe(false);
    }
  });
});

describe('main.cjs wiring', () => {
  const code = stripComments(readFileSync(join(__dirname, '..', 'electron', 'main.cjs'), 'utf8'));
  const count = (needle: string) => code.split(needle).length - 1;

  it('decides from the real process facts and the loaded prefs, applies once, before app ready', () => {
    const decideAt = code.indexOf('const shaderDiskCache = decideShaderDiskCache({');
    const applyAt = code.indexOf('applyShaderDiskCacheSwitches(app, shaderDiskCache);');
    const loadAt = code.indexOf('const desktopPrefs = loadDesktopPrefs(desktopPrefsPath);');
    const readyAt = code.indexOf('app.whenReady()');
    expect(decideAt, 'the decision is gone').toBeGreaterThan(-1);
    expect(applyAt, 'the switches are no longer applied').toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(loadAt).toBeLessThan(decideAt);
    expect(decideAt).toBeLessThan(applyAt);
    expect(applyAt, 'Chromium reads its switches at ready').toBeLessThan(readyAt);
    // Before anything that can await: the whole block runs synchronously at module scope.
    expect(code.slice(0, applyAt)).not.toMatch(/\bawait\b/);
    expect(count('decideShaderDiskCache(')).toBe(1);
    expect(count('applyShaderDiskCacheSwitches(')).toBe(1);
    const decision = code.slice(decideAt, code.indexOf('});', decideAt)).replace(/\s+/g, ' ');
    expect(decision).toContain('platform: process.platform,');
    expect(decision).toContain('env: process.env,');
    expect(decision).toContain('prefs: desktopPrefs,');
    // The support line a ticket greps for.
    expect(code).toContain(
      "`[gpu] shader disk cache: ${shaderDiskCache.enabled ? 'on' : 'off'} (${shaderDiskCache.reason})`",
    );
  });
});

describe('every enable-features writer goes through the merge', () => {
  it('no shell module appends the switch on its own', () => {
    // A raw appendSwitch('enable-features', ...) anywhere would replace the other levers'
    // features. The literal may only live in the merge helper and in gpu_backend's switch
    // table (which applyGpuBackendSwitches routes through the helper, pinned above).
    const dir = join(__dirname, '..', 'electron');
    const holders = readdirSync(dir)
      .filter((f) => f.endsWith('.cjs'))
      .filter((f) =>
        stripComments(readFileSync(join(dir, f), 'utf8')).includes("'enable-features'"),
      )
      .sort();
    expect(holders).toEqual(['chromium_features.cjs', 'gpu_backend.cjs']);
    const others = readdirSync(dir).filter(
      (f) => f.endsWith('.cjs') && f !== 'chromium_features.cjs',
    );
    for (const f of others) {
      const src = stripComments(readFileSync(join(dir, f), 'utf8'));
      expect(src, f).not.toMatch(
        /appendSwitch\(\s*(['"]enable-features['"]|ENABLE_FEATURES_SWITCH)/,
      );
    }
  });
});
