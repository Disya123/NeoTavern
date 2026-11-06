import { describe, expect, it, vi } from 'vitest';
import { createSpring, isAtRest, projectStop, resolveConfig, rubberBand, step } from './spring.js';

const config = resolveConfig({ stiffness: 280, damping: 32, mass: 1 });

describe('spring step', () => {
  it('converges on the target and comes to rest', () => {
    let state = { value: 0, velocity: 0 };
    for (let index = 0; index < 600; index += 1) {
      state = step(state, 100, config, 1 / 60);
      if (isAtRest(state, 100, config)) break;
    }
    expect(state.value).toBeCloseTo(100, 1);
    expect(isAtRest(state, 100, config)).toBe(true);
  });

  it('never produces NaN, even with a stalled frame', () => {
    const state = step({ value: 0, velocity: 0 }, 50, config, 12);
    expect(Number.isFinite(state.value)).toBe(true);
    expect(Number.isFinite(state.velocity)).toBe(true);
  });

  it('is frame-rate independent within a tolerance', () => {
    let fast = { value: 0, velocity: 0 };
    for (let index = 0; index < 120; index += 1) fast = step(fast, 100, config, 1 / 120);
    let slow = { value: 0, velocity: 0 };
    for (let index = 0; index < 60; index += 1) slow = step(slow, 100, config, 1 / 60);
    expect(Math.abs(fast.value - slow.value)).toBeLessThan(2);
  });

  it('overshoots when damping is low, which is what makes a step feel physical', () => {
    const bouncy = resolveConfig({ stiffness: 320, damping: 14, mass: 1 });
    let state = { value: 0, velocity: 0 };
    let peak = 0;
    for (let index = 0; index < 120; index += 1) {
      state = step(state, 100, bouncy, 1 / 60);
      peak = Math.max(peak, state.value);
    }
    expect(peak).toBeGreaterThan(100);
  });
});

describe('projectStop', () => {
  it('returns the nearest step for a slow drag', () => {
    expect(projectStop(43, 0, 20, 0, 100)).toBe(40);
  });

  it('skips ahead on a fast flick', () => {
    expect(projectStop(40, 900, 20, 0, 100)).toBeGreaterThan(40);
  });

  it('clamps to the track', () => {
    expect(projectStop(95, 5000, 20, 0, 100)).toBe(100);
    expect(projectStop(5, -5000, 20, 0, 100)).toBe(0);
  });
});

describe('rubberBand', () => {
  it('gives less the further past the edge', () => {
    const near = rubberBand(10, 400);
    const far = rubberBand(200, 400);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(200);
  });

  it('keeps the sign of the overshoot', () => {
    expect(rubberBand(-40, 400)).toBeLessThan(0);
  });
});

describe('createSpring', () => {
  it('applies the target immediately under reduced motion', () => {
    const frames: number[] = [];
    createSpring({
      to: 42,
      reducedMotion: true,
      onFrame: (value) => frames.push(value),
    });
    expect(frames).toEqual([42]);
  });

  it('keeps velocity when retargeted mid-flight', () => {
    const frames: number[] = [];
    let handle: ReturnType<typeof createSpring> | null = null;
    const callbacks: Array<(time: number) => void> = [];
    let clock = 0;
    const onFrame = vi.fn((value: number) => frames.push(value));

    handle = createSpring({
      from: 0,
      to: 100,
      onFrame,
      now: () => clock,
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelFrame: () => {},
    });

    // Advance three frames toward 100.
    for (let index = 0; index < 3; index += 1) {
      clock += 16;
      callbacks.shift()?.(clock);
    }
    const moving = frames.at(-1) ?? 0;
    expect(moving).toBeGreaterThan(0);

    // Retarget: the spring should not restart from zero.
    handle.to(0);
    clock += 16;
    callbacks.shift()?.(clock);
    expect(frames.at(-1) ?? 0).toBeGreaterThan(0);
  });
});
