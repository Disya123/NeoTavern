/**
 * Pseudo-locale for testing (ТЗ §9: mandatory pseudo-locale + long-string test).
 * Wraps every English string so missing translations and hardcoded strings are
 * visually obvious, and pads text to surface layout overflow.
 */
import { en, type Resources } from './resources/en.js';

function pseudoValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Preserve {{interpolation}} placeholders; pad ~30% to catch overflow.
    const pad = '~'.repeat(Math.max(2, Math.round(value.length * 0.3)));
    return `[!! ${value} ${pad} !!]`;
  }
  if (Array.isArray(value)) return value.map(pseudoValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = pseudoValue(val);
    return out;
  }
  return value;
}

export const pseudoLocale: Resources = pseudoValue(en) as Resources;
