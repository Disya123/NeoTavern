/** Localize an API error code to a user-facing string via i18next. */
import { useTranslation } from 'react-i18next';
import { localizeError } from '@neotavern/i18n';
import { ApiError } from '../api/client.js';
import { UnsupportedError } from '@neotavern/neobackend';

export function useErrorText(): (error: unknown) => string {
  const { i18n } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof UnsupportedError) {
      // CAPABILITY_UNAVAILABLE (ТЗ §13.1): the feature exists on the legacy
      // plane only, or requires a host-side capability the web transport
      // cannot reach. Localized honestly instead of masquerading as INTERNAL.
      return localizeError(i18n, 'UNSUPPORTED', { feature: error.feature });
    }
    if (error instanceof ApiError) {
      return localizeError(i18n, error.code, error.params);
    }
    return localizeError(i18n, 'INTERNAL');
  };
}
