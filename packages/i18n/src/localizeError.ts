/**
 * Frontend error localization. The backend returns a stable error `code` and
 * `params`; this maps them to a translated message (AGENTS.md §16 — the backend
 * never sends ready-made user-facing strings).
 */
import type { i18n } from 'i18next';

/** Localize an error code, interpolating params. Falls back to errors:UNKNOWN. */
export function localizeError(
  instance: i18n,
  code: string,
  params: Record<string, unknown> = {},
): string {
  const unknown = instance.t('errors:UNKNOWN') as string;
  return instance.t(`errors:${code}`, {
    ...params,
    defaultValue: unknown,
  }) as string;
}
