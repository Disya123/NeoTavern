/** Localize an API error code to a user-facing string via i18next. */
import { useTranslation } from 'react-i18next';
import { localizeError } from '@neotavern/i18n';
import { ApiError } from '../api/client.js';

export function useErrorText(): (error: unknown) => string {
  const { i18n } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      return localizeError(i18n, error.code, error.params);
    }
    return localizeError(i18n, 'INTERNAL');
  };
}
