#!/usr/bin/env -S node --import tsx
/**
 * Local performance benchmark for the ТЗ §18 data-path targets:
 *  - first catalog page out of 100 000 characters — ≤ 300 ms;
 *  - opening a chat with 10 000 messages (latest messages loaded) — ≤ 700 ms.
 *
 * Seeds a throwaway database, measures repository hot paths and prints a
 * report. Exits non-zero when a target is missed, so the harness can gate on
 * it; seed sizes are overridable via NEOTA_BENCH_* env vars for quick local runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { uuidv7 } from '@neotavern/shared';
import { createAppDatabase } from '../src/database.js';

const CHARACTER_COUNT = Number(process.env['NEOTA_BENCH_CHARACTERS'] ?? 100_000);
const MESSAGE_COUNT = Number(process.env['NEOTA_BENCH_MESSAGES'] ?? 10_000);
const CATALOG_PAGE_TARGET_MS = 300;
const CHAT_OPEN_TARGET_MS = 700;

const directory = mkdtempSync(join(tmpdir(), 'neotavern-benchmark-'));
const dbPath = join(directory, 'bench.db');

async function measure(label: string, run: () => unknown): Promise<number> {
  const started = performance.now();
  await run();
  const elapsed = performance.now() - started;
  console.log(`[bench] ${label}: ${elapsed.toFixed(1)} ms`);
  return elapsed;
}

try {
  const db = createAppDatabase(dbPath);
  const sqlite = db.sqlite;

  console.log(`[bench] seeding ${CHARACTER_COUNT} characters…`);
  const insertCharacter = sqlite.prepare(
    `INSERT INTO characters
       (id, name, description, personality, scenario, first_message,
        example_dialogues, ext, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '', '{}', ?, ?)`,
  );
  const seedCharacters = sqlite.transaction((count: number) => {
    const base = Date.now() - count;
    for (let index = 0; index < count; index += 1) {
      insertCharacter.run(
        uuidv7(),
        `Character ${index}`,
        `Description of character number ${index}. Fantasy adventurer.`,
        base + index,
        base + index,
      );
    }
  });
  await measure('seed characters', () => seedCharacters(CHARACTER_COUNT));

  console.log(`[bench] seeding one chat with ${MESSAGE_COUNT} messages…`);
  const chatId = uuidv7();
  const branchId = uuidv7();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO chats (id, title, active_branch_id, summary, message_count, created_at, updated_at)
       VALUES (?, 'Bench chat', ?, '', ?, ?, ?)`,
    )
    .run(chatId, branchId, MESSAGE_COUNT, now, now);
  sqlite
    .prepare(`INSERT INTO chat_branches (id, chat_id, name, created_at) VALUES (?, ?, 'main', ?)`)
    .run(branchId, chatId, now);
  const insertMessage = sqlite.prepare(
    `INSERT INTO messages (id, chat_id, branch_id, role, content, meta, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
  );
  const seedMessages = sqlite.transaction((count: number) => {
    for (let index = 0; index < count; index += 1) {
      insertMessage.run(
        uuidv7(),
        chatId,
        branchId,
        index % 2 === 0 ? 'user' : 'assistant',
        `Message ${index}: the quick brown fox jumps over the lazy dog.`,
        now + index,
      );
    }
  });
  await measure('seed messages', () => seedMessages(MESSAGE_COUNT));

  // --- ТЗ §18: first catalog page ≤ 300 ms (recent + name + usage sorts). ---
  const recentPage = await measure('catalog page (recent)', () =>
    db.repos.characters.list({ limit: 50 }),
  );
  await measure('catalog page (name)', () => db.repos.characters.list({ limit: 50, sort: 'name' }));
  await measure('catalog page (usage)', () =>
    db.repos.characters.list({ limit: 50, sort: 'usage' }),
  );
  await measure('catalog search (FTS)', () =>
    db.repos.search.search('adventurer', 'characters', 50),
  );
  await measure('FTS rebuild', () => db.repos.search.rebuild());

  // --- ТЗ §18: chat with 10 000 messages opens ≤ 700 ms. ---
  const chatOpen = await measure('chat open (latest 200 messages)', () =>
    db.repos.messages.recentAscending(chatId, branchId, 200),
  );
  await measure('message list page (desc)', () =>
    db.repos.messages.list(chatId, { branchId, limit: 100 }),
  );
  await measure('message count', () => db.repos.messages.count(chatId, branchId));

  const catalogOk = recentPage <= CATALOG_PAGE_TARGET_MS;
  const chatOk = chatOpen <= CHAT_OPEN_TARGET_MS;
  console.log(
    `[bench] catalog first page ${recentPage.toFixed(1)} ms ` +
      `(target ${CATALOG_PAGE_TARGET_MS} ms): ${catalogOk ? 'PASS' : 'FAIL'}`,
  );
  console.log(
    `[bench] chat open ${chatOpen.toFixed(1)} ms ` +
      `(target ${CHAT_OPEN_TARGET_MS} ms): ${chatOk ? 'PASS' : 'FAIL'}`,
  );
  db.close();
  if (!catalogOk || !chatOk) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
