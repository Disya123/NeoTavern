import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyPresentationStream,
  assertPresentationConsumesWire,
  productWireOperationIds,
  recordPresentationFixture,
  type PresentationCommand,
} from '../src/presentation/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../src/presentation/fixtures');

type CanonicalFixture = {
  chat: { id: string; title: string };
  messages: Array<{ id: string }>;
  commands: PresentationCommand[];
  stream: Array<{ generation: number; text: string }>;
  streamCap: number;
};

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as T;
}

describe('React ↔ Dioxus Product Wire fixture parity', () => {
  const fixture = loadJson<CanonicalFixture>('canonical-chat.json');
  const expected = loadJson<Record<string, unknown>>('expected-projection.json');
  const committedIds = loadJson<string[]>('wire-operation-ids.json');

  it('keeps the committed operation-id snapshot in sync with Product Wire', () => {
    expect(committedIds).toEqual([...productWireOperationIds()].sort());
  });

  it('accepts only registered typed commands from the shared fixture', () => {
    const recorded = recordPresentationFixture(
      'dioxus-android-flagged',
      fixture.commands,
      'Milestone A Product Wire shell fixture; not MainActivity',
    );
    expect(recorded.wireOperationIds).toEqual([
      'chats.get',
      'chats.messages.list',
      'generation.cancel',
    ]);
    expect(() =>
      assertPresentationConsumesWire({ wireOperationId: 'presentation.bypassSqlite' }),
    ).toThrow(/Product Wire/);
  });

  it('projects the same canonical view model the Dioxus shell must match', () => {
    const stream = applyPresentationStream(fixture.stream, fixture.streamCap);
    const projection = {
      chatId: fixture.chat.id,
      title: fixture.chat.title,
      messageIds: fixture.messages.map((row) => row.id),
      issuedCommands: fixture.commands.map((row) => row.wireOperationId),
      ...stream,
    };
    expect(projection).toEqual(expected);
  });
});
