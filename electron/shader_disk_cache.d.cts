// Type declarations for electron/shader_disk_cache.cjs, which electron/main.cjs invokes at
// runtime and tests/electron_shader_disk_cache.test.ts exercises directly. main.cjs itself
// runs outside tsc; these types serve the test.

import type { FeatureCommandLine } from './chromium_features.cjs';

export const SHADER_DISK_CACHE_FEATURE: string;
export const GPU_DISK_CACHE_SIZE_SWITCH: string;
export const GPU_DISK_CACHE_SIZE_KB: number;
export const SHADER_DISK_CACHE_DISABLE_ENV: string;
export const SHADER_DISK_CACHE_PLATFORMS: readonly string[];

export interface ShaderDiskCacheDecision {
  enabled: boolean;
  reason: string;
}

export function decideShaderDiskCache(input: {
  platform: string;
  env?: Record<string, string | undefined> | null;
  prefs?: { shaderDiskCacheOptOut?: boolean } | null;
}): ShaderDiskCacheDecision;

export function applyShaderDiskCacheSwitches(
  app: { commandLine: FeatureCommandLine & { hasSwitch?(name: string): boolean } },
  decision: ShaderDiskCacheDecision | null | undefined,
): void;
