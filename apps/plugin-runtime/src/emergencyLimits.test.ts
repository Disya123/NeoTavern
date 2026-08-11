/**
 * Emergency resource boundary from headroom (ADR-0026 §22): the ceiling is
 * an emergency cap, not a quota — generous when the system has headroom,
 * clamped to a floor when it does not, raised toward the plugin memory hint
 * when possible, and overridable by admin config (§39).
 */
import { describe, expect, it } from 'vitest';
import {
  EMERGENCY_MAX_OLD_GEN_MB,
  EMERGENCY_MAX_YOUNG_GEN_MB,
  EMERGENCY_MIN_OLD_GEN_MB,
  EMERGENCY_MIN_YOUNG_GEN_MB,
  computeEmergencyLimits,
  resolveEmergencyLimits,
} from './emergencyLimits.js';

const MIB = 1024 * 1024;

const HEALTHY = {
  totalMemory: 16 * 1024 * MIB,
  freeMemory: 8 * 1024 * MIB,
  runtimeRss: 300 * MIB,
  activeWorkerCount: 0,
};

describe('computeEmergencyLimits (headroom model)', () => {
  it('grants a large ceiling on a healthy machine (free resource is usable)', () => {
    const limits = computeEmergencyLimits(HEALTHY);
    // 8 GiB free × 0.75 − 0.3 GiB ≈ 5.7 GiB → damage cap 4 GiB.
    expect(limits.maxOldGenerationSizeMb).toBe(EMERGENCY_MAX_OLD_GEN_MB);
    expect(limits.maxYoungGenerationSizeMb).toBe(EMERGENCY_MAX_YOUNG_GEN_MB);
  });

  it('scales the ceiling down with actual headroom', () => {
    // 1.5 GiB free × 0.75 − 0.2 GiB runtime ≈ 947 MiB.
    const limits = computeEmergencyLimits({
      totalMemory: 3 * 1024 * MIB,
      freeMemory: 1.5 * 1024 * MIB,
      runtimeRss: 200 * MIB,
      activeWorkerCount: 0,
    });
    expect(limits.maxOldGenerationSizeMb).toBeGreaterThan(900);
    expect(limits.maxOldGenerationSizeMb).toBeLessThan(1000);
    // young = old/4 clamped.
    expect(limits.maxYoungGenerationSizeMb).toBe(Math.floor(limits.maxOldGenerationSizeMb / 4));
  });

  it('never drops below the emergency floor, even with no headroom', () => {
    const limits = computeEmergencyLimits({
      totalMemory: 3 * 1024 * MIB,
      freeMemory: 300 * MIB,
      runtimeRss: 250 * MIB,
      activeWorkerCount: 8,
    });
    expect(limits.maxOldGenerationSizeMb).toBe(EMERGENCY_MIN_OLD_GEN_MB);
    expect(limits.maxYoungGenerationSizeMb).toBe(EMERGENCY_MIN_YOUNG_GEN_MB);
  });

  it('reserves floor space for live workers (fanout cannot eat the whole budget)', () => {
    const base = {
      totalMemory: 3 * 1024 * MIB,
      freeMemory: 2 * 1024 * MIB,
      runtimeRss: 200 * MIB,
    };
    const first = computeEmergencyLimits({ ...base, activeWorkerCount: 0 });
    const crowded = computeEmergencyLimits({ ...base, activeWorkerCount: 6 });
    expect(crowded.maxOldGenerationSizeMb).toBeLessThan(first.maxOldGenerationSizeMb);
  });

  it('raises the ceiling toward the plugin memory hint when headroom permits', () => {
    const limits = computeEmergencyLimits({
      ...HEALTHY,
      memoryHintMiB: 2048,
    });
    expect(limits.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(2048);
  });

  it('keeps the hint when headroom is smaller than the hint (declared need wins)', () => {
    const limits = computeEmergencyLimits({
      totalMemory: 3 * 1024 * MIB,
      freeMemory: 1 * 1024 * MIB,
      runtimeRss: 200 * MIB,
      activeWorkerCount: 0,
      memoryHintMiB: 768,
    });
    // headroom ≈ 550 MiB, hint 768 → ceiling = hint.
    expect(limits.maxOldGenerationSizeMb).toBe(768);
  });

  it('ignores the hint when headroom is even larger', () => {
    const limits = computeEmergencyLimits({
      ...HEALTHY,
      memoryHintMiB: 512,
    });
    expect(limits.maxOldGenerationSizeMb).toBe(EMERGENCY_MAX_OLD_GEN_MB);
  });

  it('applies the admin override instead of the whole calculation (§39)', () => {
    const limits = computeEmergencyLimits({
      ...HEALTHY,
      maxHeapOverrideMiB: 512,
    });
    expect(limits.maxOldGenerationSizeMb).toBe(512);
    expect(limits.maxYoungGenerationSizeMb).toBe(128);
  });

  it('clamps overrides to the emergency bounds', () => {
    const tiny = computeEmergencyLimits({ ...HEALTHY, maxHeapOverrideMiB: 10 });
    expect(tiny.maxOldGenerationSizeMb).toBe(EMERGENCY_MIN_OLD_GEN_MB);
    const huge = computeEmergencyLimits({ ...HEALTHY, maxHeapOverrideMiB: 100_000 });
    expect(huge.maxOldGenerationSizeMb).toBe(EMERGENCY_MAX_OLD_GEN_MB);
  });

  it('bounds young generation', () => {
    const floor = computeEmergencyLimits({
      ...HEALTHY,
      freeMemory: 100 * MIB,
      runtimeRss: 90 * MIB,
    });
    expect(floor.maxYoungGenerationSizeMb).toBe(EMERGENCY_MIN_YOUNG_GEN_MB);
    const ceiling = computeEmergencyLimits(HEALTHY);
    expect(ceiling.maxYoungGenerationSizeMb).toBe(EMERGENCY_MAX_YOUNG_GEN_MB);
  });
});

describe('resolveEmergencyLimits (precedence)', () => {
  const inputs = HEALTHY;

  it('explicit per-spawn caps win over static and dynamic', () => {
    const limits = resolveEmergencyLimits({
      explicitOldGenMb: 1024,
      explicitYoungGenMb: 256,
      staticLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 128 },
      inputs,
    });
    expect(limits).toEqual({ maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 256 });
  });

  it('derives young gen from old gen when only old is explicit', () => {
    const limits = resolveEmergencyLimits({
      explicitOldGenMb: 2048,
      inputs,
    });
    expect(limits.maxOldGenerationSizeMb).toBe(2048);
    expect(limits.maxYoungGenerationSizeMb).toBe(512);
  });

  it('static configuration beats dynamic headroom', () => {
    const limits = resolveEmergencyLimits({
      staticLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 128 },
      inputs,
    });
    expect(limits).toEqual({ maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 128 });
  });

  it('falls back to headroom when nothing else is configured', () => {
    const limits = resolveEmergencyLimits({ inputs });
    expect(limits.maxOldGenerationSizeMb).toBeGreaterThanOrEqual(EMERGENCY_MIN_OLD_GEN_MB);
    expect(limits.maxOldGenerationSizeMb).toBeLessThanOrEqual(EMERGENCY_MAX_OLD_GEN_MB);
  });
});
