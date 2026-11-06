import { useEffect, useRef, useState } from 'react';

/**
 * Spring physics for UI motion.
 *
 * CSS transitions cannot express inertia: they have a fixed duration and no memory of
 * velocity, so a flick or a half-dragged slider stops dead instead of settling. This is
 * the small integrator the rest of the app animates with — Apple-style springs, interruptible
 * mid-flight, and reduced motion collapses them to an instant step.
 *
 * Only `transform` and `opacity` should be driven from here; nothing in this module reads
 * layout, so a spring never triggers reflow.
 */

export interface SpringConfig {
  /** Higher pulls harder: 120 is tight, 300 is snappy. */
  stiffness: number;
  /** Higher bleeds energy: damping = 2 * sqrt(stiffness * mass) is critically damped. */
  damping: number;
  mass: number;
  /** Below this distance and velocity the spring is considered settled. */
  restDistance: number;
  restVelocity: number;
}

export const SPRING_PRESETS = {
  /** Menus, popovers, anything that should arrive without a wobble. */
  settle: { stiffness: 280, damping: 32, mass: 1 },
  /** Panels and sheets: a little weight, no overshoot. */
  panel: { stiffness: 220, damping: 28, mass: 1 },
  /** Slider thumbs and switches: plays back with one gentle overshoot. */
  step: { stiffness: 320, damping: 26, mass: 1 },
  /** Fling inertia: low stiffness so the velocity carries. */
  momentum: { stiffness: 90, damping: 20, mass: 1 },
} as const satisfies Record<string, Omit<SpringConfig, 'restDistance' | 'restVelocity'>>;

export interface SpringState {
  value: number;
  velocity: number;
}

const DEFAULTS: SpringConfig = {
  stiffness: 280,
  damping: 32,
  mass: 1,
  restDistance: 0.001,
  restVelocity: 0.01,
};

export function resolveConfig(config: Partial<SpringConfig> = {}): SpringConfig {
  return { ...DEFAULTS, ...config };
}

/**
 * One integration step. Uses semi-implicit Euler at a fixed 1/240 s sub-step so behaviour
 * does not change with frame rate, and clamps dt so a stalled tab cannot explode the state.
 */
export function step(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dtSeconds: number,
): SpringState {
  const total = Math.min(Math.max(dtSeconds, 0), 0.064);
  let { value, velocity } = state;
  const subSteps = Math.max(1, Math.ceil(total / (1 / 240)));
  const h = total / subSteps;

  for (let index = 0; index < subSteps; index += 1) {
    const displacement = value - target;
    const springForce = -config.stiffness * displacement;
    const dampingForce = -config.damping * velocity;
    const acceleration = (springForce + dampingForce) / config.mass;
    velocity += acceleration * h;
    value += velocity * h;
  }

  return { value, velocity };
}

export function isAtRest(state: SpringState, target: number, config: SpringConfig): boolean {
  return (
    Math.abs(state.value - target) <= config.restDistance &&
    Math.abs(state.velocity) <= config.restVelocity
  );
}

export interface SpringHandle {
  /** Retarget without losing velocity: the whole point of a spring. */
  to(target: number, config?: Partial<SpringConfig>): void;
  /** Nudge the current velocity (a flick, a drag release). */
  addVelocity(velocity: number): void;
  stop(): void;
}

export interface SpringOptions {
  from?: number;
  to: number;
  config?: Partial<SpringConfig>;
  onFrame(value: number, velocity: number): void;
  /** Defaults to matchMedia; injected in tests. */
  reducedMotion?: boolean;
  /** Defaults to requestAnimationFrame; injected in tests. */
  now?: () => number;
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

export function createSpring(options: SpringOptions): SpringHandle {
  let config = resolveConfig(options.config);
  let state: SpringState = { value: options.from ?? options.to, velocity: 0 };
  let target = options.to;
  let frame: number | null = null;
  let last = options.now?.() ?? performance.now();

  const request = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancel = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  const finish = (): void => {
    options.onFrame(target, 0);
  };

  if (options.reducedMotion) {
    finish();
    return { to: (next) => options.onFrame(next, 0), addVelocity: () => {}, stop: () => {} };
  }

  const tick = (time: number): void => {
    const dt = (time - last) / 1000;
    last = time;
    state = step(state, target, config, dt);
    options.onFrame(state.value, state.velocity);
    if (isAtRest(state, target, config)) {
      state = { value: target, velocity: 0 };
      options.onFrame(target, 0);
      frame = null;
      return;
    }
    frame = request(tick);
  };

  const ensureRunning = (): void => {
    if (frame !== null) return;
    last = options.now?.() ?? performance.now();
    frame = request(tick);
  };

  // A spring created away from its target starts moving at once; one created on target
  // stays still until something retargets it.
  if (state.value !== target) ensureRunning();

  return {
    to(next, nextConfig) {
      target = next;
      if (nextConfig) config = resolveConfig({ ...config, ...nextConfig });
      ensureRunning();
    },
    addVelocity(velocity) {
      state = { ...state, velocity: state.velocity + velocity };
      ensureRunning();
    },
    stop() {
      if (frame !== null) cancel(frame);
      frame = null;
    },
  };
}

/**
 * Where a fling should land: the nearest stop in the direction of travel, biased by
 * velocity so a fast flick skips one step instead of crawling back to the nearest.
 */
export function projectStop(
  position: number,
  velocity: number,
  stepSize: number,
  min: number,
  max: number,
): number {
  const projected = position + velocity * 0.25;
  const index = Math.round(projected / stepSize);
  const snapped = index * stepSize;
  return Math.min(Math.max(snapped, min), max);
}

/** Rubber-band resistance past an edge: the further past, the less it gives. */
export function rubberBand(overshoot: number, dimension: number, coefficient = 0.55): number {
  if (dimension <= 0) return 0;
  const sign = Math.sign(overshoot);
  const distance = Math.abs(overshoot);
  return (sign * (1 - 1 / ((distance * coefficient) / dimension + 1)) * dimension) / 1;
}

/**
 * A number that chases `target` on a spring and can be interrupted mid-flight. Used where a
 * CSS transition would restart from zero — an open/close a user can reverse with a second tap.
 */
export function useSpringValue(target: number, config: Partial<SpringConfig> = {}): number {
  const [value, setValue] = useState(target);
  const handle = useRef<SpringHandle | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    handle.current?.stop();
    handle.current = createSpring({
      from: latest.current,
      to: target,
      config,
      reducedMotion: prefersReducedMotion(),
      onFrame: (frame) => setValue(frame),
    });
    return () => handle.current?.stop();
    // `config` is a literal at every call site; comparing it would restart the spring on
    // every render, which is worse than an intentional omission here.
  }, [target]);

  return value;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
