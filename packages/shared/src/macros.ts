/**
 * Macro substitution (ТЗ §4.4 / AGENTS.md §9). Resolved BEFORE final instruct
 * rendering.
 *
 * Supported macros:
 * - `{{user}}`, `{{char}}` — persona/character display names;
 * - `{{time}}`, `{{date}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}`,
 *   `{{hour}}`, `{{minute}}`, `{{weekday}}`, `{{isNight}}` — local time macros;
 * - `{{random:one~two~three}}` — a uniformly random alternative;
 * - any other `{{name}}` — a user-defined variable from the macro context
 *   (settings `macroVariables`); unknown macros are left untouched.
 */
export interface MacroContext {
  userName: string;
  charName: string;
  /** User-defined variables (settings-driven). */
  variables?: Record<string, string>;
  /** Current time for time macros; injectable for deterministic tests. */
  now?: Date;
}

const RANDOM_RE = /\{\{\s*random\s*:\s*([^}]+)\}\}/gi;
const VAR_RE = /\{\{\s*([\w-]+)\s*\}\}/g;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function replaceMacros(text: string, ctx: MacroContext): string {
  const now = ctx.now ?? new Date();

  // Random alternatives first, so picked values may still contain {{macros}}.
  const withRandom = text.replace(RANDOM_RE, (_match, body: string) => {
    const options = body
      .split('~')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (options.length === 0) return '';
    return options[Math.floor(Math.random() * options.length)] ?? '';
  });

  return withRandom.replace(VAR_RE, (match, key: string) => {
    switch (key.toLowerCase()) {
      case 'user':
        return ctx.userName;
      case 'char':
        return ctx.charName;
      case 'time':
        return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      case 'date':
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      case 'datetime':
        return (
          `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
          `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
        );
      case 'year':
        return String(now.getFullYear());
      case 'month':
        return pad2(now.getMonth() + 1);
      case 'day':
        return pad2(now.getDate());
      case 'hour':
        return pad2(now.getHours());
      case 'minute':
        return pad2(now.getMinutes());
      case 'weekday':
        return new Intl.DateTimeFormat('en', { weekday: 'long' }).format(now);
      case 'isnight':
        return now.getHours() >= 22 || now.getHours() < 6 ? 'true' : 'false';
      default: {
        const custom = ctx.variables?.[key];
        return custom ?? match;
      }
    }
  });
}

/** Build a macro context with SillyTavern-compatible fallbacks. */
export function buildMacroContext(input: {
  userName?: string | null;
  charName?: string | null;
  variables?: Record<string, string>;
  now?: Date;
}): MacroContext {
  return {
    userName: input.userName?.trim() || 'User',
    charName: input.charName?.trim() || 'Assistant',
    variables: input.variables,
    now: input.now,
  };
}
