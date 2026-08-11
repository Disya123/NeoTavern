/** Character editor draft mapping; preserves unknown extension fields on save. */
import type { Character, PromptAuthoringRole } from '@neotavern/contracts';

export type PromptRole = PromptAuthoringRole;

export interface CharacterDraft {
  name: string;
  avatar: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogues: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creator: string;
  creatorNotes: string;
  tags: string[];
  favorite: boolean;
  alternateGreetings: string[];
  characterVersion: string;
  characterNote: string;
  characterNoteDepth: number;
  characterNoteRole: PromptRole;
  talkativeness: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function characterToDraft(character: Character): CharacterDraft {
  const depthPrompt = objectValue(character.ext['depthPrompt']);
  const role = depthPrompt?.['role'];
  const legacy = objectValue(character.ext['legacy']);
  return {
    name: character.name,
    avatar: character.avatar ?? '',
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    firstMessage: character.firstMessage,
    exampleDialogues: character.exampleDialogues,
    systemPrompt: character.systemPrompt ?? '',
    postHistoryInstructions: character.postHistoryInstructions ?? '',
    creator: character.creator ?? '',
    creatorNotes: character.creatorNotes ?? '',
    tags: character.tags,
    favorite: character.ext['favorite'] === true || legacy?.['favorite'] === true,
    alternateGreetings: Array.isArray(character.ext['alternateGreetings'])
      ? character.ext['alternateGreetings'].filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    characterVersion:
      typeof character.ext['characterVersion'] === 'string'
        ? character.ext['characterVersion']
        : '',
    characterNote: typeof depthPrompt?.['prompt'] === 'string' ? depthPrompt['prompt'] : '',
    characterNoteDepth: Math.max(0, Math.round(numberValue(depthPrompt?.['depth'], 4))),
    characterNoteRole:
      role === 'user' || role === 'assistant' || role === 'system' ? role : 'system',
    talkativeness: Math.min(
      1,
      Math.max(
        0,
        numberValue(character.ext['talkativeness'], numberValue(legacy?.['talkativeness'], 0.5)),
      ),
    ),
  };
}
