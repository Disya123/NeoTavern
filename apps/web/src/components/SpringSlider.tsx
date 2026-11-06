import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSpring,
  prefersReducedMotion,
  projectStop,
  SPRING_PRESETS,
} from '../motion/spring.js';
import styles from './SpringSlider.module.css';

export interface SpringSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled?: boolean;
  onChange(value: number): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function snap(value: number, min: number, max: number, step: number): number {
  const steps = Math.round((value - min) / step);
  return clamp(min + steps * step, min, max);
}

/**
 * A slider with weight: the thumb follows the finger while dragging, a fast flick carries
 * past the nearest stop, and on release the value springs onto its step instead of stopping
 * dead. Native range inputs cannot do any of the last two.
 */
export function SpringSlider({
  value,
  min,
  max,
  step,
  label,
  disabled = false,
  onChange,
}: SpringSliderProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const springRef = useRef<ReturnType<typeof createSpring> | null>(null);
  const [visual, setVisual] = useState(value);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startValue: number;
    lastX: number;
    lastTime: number;
    velocity: number;
  } | null>(null);

  const span = max - min || 1;
  const percent = ((clamp(visual, min, max) - min) / span) * 100;

  const animateTo = useCallback(
    (target: number) => {
      springRef.current?.stop();
      springRef.current = createSpring({
        from: visual,
        to: clamp(target, min, max),
        config: SPRING_PRESETS.step,
        reducedMotion: prefersReducedMotion(),
        onFrame: (frame) => setVisual(frame),
      });
    },
    [visual, min, max],
  );

  useEffect(() => {
    if (dragging) return;
    const settled = snap(value, min, max, step);
    if (Math.abs(settled - visual) < 0.0001) return;
    animateTo(settled);
    // `visual` changes every frame; re-running on it would restart the spring each time.
  }, [value, min, max, step, dragging]);

  useEffect(() => () => springRef.current?.stop(), []);

  const valueFromClientX = (clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return value;
    const rect = track.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / (rect.width || 1), 0, 1);
    return min + ratio * span;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    springRef.current?.stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    const raw = valueFromClientX(event.clientX);
    dragRef.current = {
      startX: event.clientX,
      startValue: raw,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    };
    setDragging(true);
    setVisual(raw);
    onChange(snap(raw, min, max, step));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || disabled) return;
    const dt = Math.max(event.timeStamp - drag.lastTime, 1);
    drag.velocity = ((event.clientX - drag.lastX) / dt) * 1000;
    drag.lastX = event.clientX;
    drag.lastTime = event.timeStamp;
    const raw = valueFromClientX(event.clientX);
    setVisual(raw);
    onChange(snap(raw, min, max, step));
  };

  const endDrag = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    setDragging(false);
    // Velocity in value units, not pixels: a flick across the track should skip a stop.
    const pixelsPerUnit = (trackRef.current?.getBoundingClientRect().width ?? 1) / span;
    const valueVelocity = (drag.velocity / (pixelsPerUnit || 1)) * 0.25;
    const target = projectStop(visual, valueVelocity, step, min, max);
    onChange(snap(target, min, max, step));
    animateTo(target);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const keys: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
    };
    if (event.key in keys) {
      event.preventDefault();
      const next = clamp(snap(value, min, max, step) + keys[event.key]!, min, max);
      onChange(next);
      animateTo(next);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      onChange(min);
      animateTo(min);
    }
    if (event.key === 'End') {
      event.preventDefault();
      onChange(max);
      animateTo(max);
    }
  };

  const percentText = useMemo(() => `${Math.round(percent)}%`, [percent]);

  return (
    <div
      className={styles.slider}
      data-dragging={dragging ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
    >
      <div
        ref={trackRef}
        className={styles.track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={snap(value, min, max, step)}
        aria-valuetext={`${snap(value, min, max, step)} (${percentText})`}
        aria-disabled={disabled || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.fill} style={{ width: `${percent}%` }} />
        <span className={styles.thumb} style={{ insetInlineStart: `${percent}%` }} />
      </div>
    </div>
  );
}
