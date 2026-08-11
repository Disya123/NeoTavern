function parseTimeMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const msMatch = /^([\d.]+)ms$/u.exec(trimmed);
  if (msMatch) return Number.parseFloat(msMatch[1]!);
  const secMatch = /^([\d.]+)s$/u.exec(trimmed);
  if (secMatch) return Number.parseFloat(secMatch[1]!) * 1000;
  const num = Number.parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
}

/** Read a theme token duration from `document.documentElement` (e.g. `1000ms`). */
export function readTokenMs(variableName: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const parsed = parseTimeMs(
    getComputedStyle(document.documentElement).getPropertyValue(variableName),
  );
  return parsed ?? fallback;
}
