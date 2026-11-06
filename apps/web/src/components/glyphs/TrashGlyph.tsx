import { useId } from 'react';
import styles from './TrashGlyph.module.css';

export interface TrashGlyphProps {
  size?: number;
  /** `armed` means the next click deletes: the lid closes and the bin leans, like a held breath. */
  state?: 'idle' | 'armed';
}

/**
 * A bin that behaves like a bin.
 *
 * The stock Trash icon is one path: the best it can do is change colour. Here the lid,
 * handle, body and two papers are separate parts, so the lid can open on hover and shut on
 * arm, the papers can fall when the action runs and the body can tilt as it is pressed.
 * That is the difference between an icon that reacts and an object that means something.
 */
export function TrashGlyph({ size = 18, state = 'idle' }: TrashGlyphProps): React.JSX.Element {
  const ids = useId().replace(/[:]/g, '');
  const lidGradient = `lid-${ids}`;
  const bodyGradient = `body-${ids}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={styles.glyph}
      data-state={state}
    >
      <defs>
        <linearGradient
          id={lidGradient}
          x1="6"
          y1="4"
          x2="18"
          y2="7"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.65" />
        </linearGradient>
        <linearGradient
          id={bodyGradient}
          x1="8"
          y1="9"
          x2="16"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>

      {/* Handle sits on the lid and travels with it. */}
      <g className={styles.lid}>
        <rect x="10" y="3" width="4" height="2" rx="1" fill={`url(#${lidGradient})`} />
        <rect x="4.5" y="5.2" width="15" height="2.4" rx="1.2" fill={`url(#${lidGradient})`} />
      </g>

      <g className={styles.body}>
        <path
          d="M6.4 9h11.2l-1 10.2a2 2 0 0 1-2 1.8H9.4a2 2 0 0 1-2-1.8L6.4 9Z"
          fill={`url(#${bodyGradient})`}
        />
        <path
          d="M10.2 11.4v6.4M13.8 11.4v6.4"
          stroke="var(--st-color-surface-canvas, #fff)"
          strokeOpacity="0.55"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </g>

      <g className={styles.paper}>
        <rect
          x="9.1"
          y="8"
          width="2"
          height="2.6"
          rx="0.6"
          transform="rotate(-12 10.1 9.3)"
          fill="currentColor"
        />
        <rect
          x="12.9"
          y="8.2"
          width="2"
          height="2.4"
          rx="0.6"
          transform="rotate(9 13.9 9.4)"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}
