/**
 * Parsing/serialization for the SillyTavern-style "Additional Parameters"
 * (include body / exclude body / include headers). The editor edits these as
 * JSON text; provider settings store them as structured values.
 *
 * Semantic validation is delegated to the shared `additionalParamIssues`
 * contract (@neotavern/contracts) — the exact same function the server applies at
 * write time — so client and server rules can never drift (ADR-0008). This
 * module only handles JSON text and maps machine-readable issue codes to
 * i18n keys.
 */
import {
  additionalParamIssues,
  type AdditionalParamIssue,
  type CustomExcludeBody,
  type CustomIncludeBody,
  type CustomIncludeHeaders,
} from '@neotavern/contracts';
import { isPlainObject, type Result } from '@neotavern/shared';

/** The three fields as JSON text, exactly as shown in the modal textareas. */
export interface AdditionalParamsValue {
  includeBody: string;
  excludeBody: string;
  includeHeaders: string;
}

/** Structured form persisted onto a provider config's `settings`. */
export interface ParsedAdditionalParams {
  customIncludeBody?: CustomIncludeBody;
  customExcludeBody?: CustomExcludeBody;
  customIncludeHeaders?: CustomIncludeHeaders;
}

export type AdditionalParamsField = 'includeBody' | 'excludeBody' | 'includeHeaders';

export interface AdditionalParamsIssue {
  field: AdditionalParamsField;
  /** i18n key under the `providers:` namespace. */
  messageKey: string;
}

export type AdditionalParamsResult = Result<ParsedAdditionalParams, AdditionalParamsIssue[]>;

/** Shared issue code → localised message key. */
const ISSUE_MESSAGE_KEYS: Record<AdditionalParamIssue['code'], string> = {
  bodyNotObject: 'additionalParamsBodyObjectError',
  excludeNotStringArray: 'additionalParamsExcludeArrayError',
  headersNotObject: 'additionalParamsHeadersObjectError',
  headerValueNotString: 'additionalParamsHeadersValueError',
  forbiddenHeader: 'additionalParamsForbiddenHeader',
  reservedBodyKey: 'additionalParamsReservedKey',
  reservedExcludeKey: 'additionalParamsReservedKey',
};

/** Settings path → editor field. */
const ISSUE_FIELDS: Record<string, AdditionalParamsField> = {
  'settings.customIncludeBody': 'includeBody',
  'settings.customExcludeBody': 'excludeBody',
  'settings.customIncludeHeaders': 'includeHeaders',
};

/** Pretty-print a stored structured value back into editable JSON text. */
export function serializeAdditionalParams(
  settings: Record<string, unknown>,
): AdditionalParamsValue {
  return {
    includeBody: toText(settings['customIncludeBody']),
    excludeBody: toText(settings['customExcludeBody']),
    includeHeaders: toText(settings['customIncludeHeaders']),
  };
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}

/** Parse and validate the JSON text fields into structured settings. */
export function parseAdditionalParams(value: AdditionalParamsValue): AdditionalParamsResult {
  const issues: AdditionalParamsIssue[] = [];
  const candidate: Record<string, unknown> = {};

  if (!parseField(value.includeBody, (decoded) => (candidate['customIncludeBody'] = decoded))) {
    issues.push({ field: 'includeBody', messageKey: 'additionalParamsInvalidJson' });
  }
  if (!parseField(value.excludeBody, (decoded) => (candidate['customExcludeBody'] = decoded))) {
    issues.push({ field: 'excludeBody', messageKey: 'additionalParamsInvalidJson' });
  }
  if (
    !parseField(value.includeHeaders, (decoded) => (candidate['customIncludeHeaders'] = decoded))
  ) {
    issues.push({ field: 'includeHeaders', messageKey: 'additionalParamsInvalidJson' });
  }

  // Semantic rules (shapes, forbidden headers, reserved body keys) come from
  // the shared contract — identical to the server-side write-time check.
  for (const issue of additionalParamIssues(candidate)) {
    issues.push({
      field: ISSUE_FIELDS[issue.path] ?? 'includeBody',
      messageKey: ISSUE_MESSAGE_KEYS[issue.code],
    });
  }

  if (issues.length > 0) return { ok: false, error: issues };

  const parsed: ParsedAdditionalParams = {};
  if (isPlainObject(candidate['customIncludeBody'])) {
    parsed.customIncludeBody = candidate['customIncludeBody'];
  }
  if (Array.isArray(candidate['customExcludeBody'])) {
    parsed.customExcludeBody = candidate['customExcludeBody'] as CustomExcludeBody;
  }
  if (isPlainObject(candidate['customIncludeHeaders'])) {
    parsed.customIncludeHeaders = candidate['customIncludeHeaders'] as CustomIncludeHeaders;
  }
  return { ok: true, value: parsed };
}

/**
 * JSON.parse a single field. Empty text is valid (means "unset") and returns
 * true without invoking `onValue`. Returns false when the text is non-empty
 * but not valid JSON; semantic validation happens afterwards.
 */
function parseField(text: string, onValue: (decoded: unknown) => void): boolean {
  if (text.trim().length === 0) return true;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return false;
  }
  onValue(decoded);
  return true;
}
