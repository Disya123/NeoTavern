/**
 * Instruct format rendering (AGENTS.md §9). The pipeline works with a clean
 * message array up to this stage; here it is rendered to a prompt string with
 * Handlebars. Templates only see content/role/name — no Node, fs, or code.
 */
import Handlebars from 'handlebars';
import type { CustomInstructFormat, MessageRole } from '@neotavern/contracts';
import { LruCache } from '@neotavern/shared';
import { IM_END, IM_START, LLAMA_END, LLAMA_START } from './tokens.js';

/**
 * Instruct format shape. Identical to the persisted custom-format contract
 * (DUP-22): the local structural twin lost every schema bound and could drift.
 */
export type InstructFormat = CustomInstructFormat;

// Isolated Handlebars environment: no HTML escaping, documented helpers only.
const hb = Handlebars.create();
hb.registerHelper('default', (value: unknown, fallback: unknown) =>
  value === undefined || value === null || value === '' ? fallback : value,
);

// Compiled templates are cached per source string. Bounded LRU: user-defined
// formats can multiply, so the cache must not grow without limit (ТЗ §11.2,
// AGENTS.md §20 — unbounded module-level Maps are forbidden).
const templateCache = new LruCache<Handlebars.TemplateDelegate>({ maxSize: 256 });

function compile(source: string): Handlebars.TemplateDelegate {
  return templateCache.getOrCompute(source, () =>
    hb.compile(source, { noEscape: true, strict: false }),
  );
}

const CONTENT = '{{{content}}}';
const NL = String.fromCharCode(10);

function chatml(role: string): string {
  return IM_START + role + NL + CONTENT + IM_END + NL;
}
function llama(role: string): string {
  return LLAMA_START + role + LLAMA_END + NL + CONTENT + NL;
}

export const CHATML: InstructFormat = {
  id: 'chatml',
  version: 1,
  system: chatml('system'),
  user: chatml('user'),
  assistant: chatml('assistant'),
  tool: chatml('tool'),
  promptSuffix: IM_START + 'assistant' + NL,
  stopStrings: [IM_END],
};

export const LLAMA3: InstructFormat = {
  id: 'llama3',
  version: 1,
  system: llama('system'),
  user: llama('user'),
  assistant: llama('assistant'),
  tool: llama('tool'),
  promptSuffix: LLAMA_START + 'assistant' + LLAMA_END + NL,
  stopStrings: [LLAMA_END],
};

export const ALPACA: InstructFormat = {
  id: 'alpaca',
  version: 1,
  system: '### Instruction:' + NL + CONTENT + NL + NL,
  user: '### Input:' + NL + CONTENT + NL + NL,
  assistant: '### Response:' + NL + CONTENT + NL + NL,
  tool: '### Tool:' + NL + CONTENT + NL + NL,
  promptSuffix: '### Response:' + NL,
  stopStrings: ['###'],
};

export const MISTRAL: InstructFormat = {
  id: 'mistral',
  version: 1,
  system: '[SYSTEM_PROMPT]' + CONTENT + '[/SYSTEM_PROMPT]',
  user: '[INST]' + CONTENT + '[/INST]',
  assistant: CONTENT + '</s>',
  tool: '[TOOL_RESULTS]' + CONTENT + '[/TOOL_RESULTS]',
  promptSuffix: '',
  stopStrings: ['</s>'],
};

const COMMAND_R_TURN = '<|START_OF_TURN_TOKEN|>';
const COMMAND_R_END = '<|END_OF_TURN_TOKEN|>';
function commandR(roleToken: string): string {
  return COMMAND_R_TURN + roleToken + CONTENT + COMMAND_R_END;
}

export const COMMAND_R: InstructFormat = {
  id: 'command-r',
  version: 1,
  system: '<BOS_TOKEN>' + commandR('<|SYSTEM_TOKEN|>'),
  user: commandR('<|USER_TOKEN|>'),
  assistant: commandR('<|CHATBOT_TOKEN|>'),
  tool: commandR('<|SYSTEM_TOKEN|>'),
  promptSuffix: COMMAND_R_TURN + '<|CHATBOT_TOKEN|>',
  stopStrings: [COMMAND_R_END],
};

const BUILTIN: Record<string, InstructFormat> = {
  chatml: CHATML,
  llama3: LLAMA3,
  alpaca: ALPACA,
  mistral: MISTRAL,
  'command-r': COMMAND_R,
};

export function getInstructFormat(id: string): InstructFormat {
  return BUILTIN[id] ?? CHATML;
}

export function listInstructFormats(): InstructFormat[] {
  return Object.values(BUILTIN);
}

export interface InstructMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

/** Render a clean message array to a prompt string using a format. */
export function renderInstruct(format: InstructFormat, messages: InstructMessage[]): string {
  let out = '';
  for (const message of messages) {
    // `plugin` messages render with the user template (no plugin template
    // exists in instruct formats; rev4 chats).
    const template =
      message.role === 'plugin' ? format.user : (format[message.role] ?? format.user);
    out += compile(template)({ content: message.content, role: message.role, name: message.name });
  }
  return out + format.promptSuffix;
}

/** Import a format from a versioned JSON preset (validates shape). */
export function importInstructFormat(input: unknown): InstructFormat {
  const record = input as Record<string, unknown>;
  if (!record || typeof record['id'] !== 'string') {
    throw new Error('Instruct format requires a string id');
  }
  const required = ['system', 'user', 'assistant', 'tool', 'promptSuffix'] as const;
  for (const key of required) {
    if (typeof record[key] !== 'string') throw new Error(`Instruct format missing "${key}"`);
  }
  return {
    id: record['id'],
    version: typeof record['version'] === 'number' ? record['version'] : 1,
    system: record['system'] as string,
    user: record['user'] as string,
    assistant: record['assistant'] as string,
    tool: record['tool'] as string,
    promptSuffix: record['promptSuffix'] as string,
    stopStrings: Array.isArray(record['stopStrings']) ? (record['stopStrings'] as string[]) : [],
  };
}

/** Export a detached, versioned JSON preset suitable for persistence or transfer. */
export function exportInstructFormat(format: InstructFormat): InstructFormat {
  return {
    id: format.id,
    version: format.version,
    system: format.system,
    user: format.user,
    assistant: format.assistant,
    tool: format.tool,
    promptSuffix: format.promptSuffix,
    stopStrings: [...format.stopStrings],
  };
}
