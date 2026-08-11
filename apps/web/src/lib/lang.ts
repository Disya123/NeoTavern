/** Document language/direction helpers (AGENTS.md §16: update <html> lang/dir). */
import { languageDirection } from '@neotavern/i18n';

export function setDocumentLanguage(code: string): void {
  document.documentElement.lang = code;
  document.documentElement.dir = languageDirection(code);
}
