/**
 * Streaming migration from a SillyTavern user-data directory extracted from a
 * ZIP archive.
 *
 * Supported today: Character Cards, solo JSONL chats (including swipes),
 * personas, Worlds/lorebooks and JSON prompt/provider presets. Unsupported
 * security-sensitive or not-yet-modelled data is reported explicitly.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, opendir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, join, relative } from 'node:path';
import type {
  DataImportConflict,
  DataImportConflictPolicy,
  DataImportCounts,
  DataImportEntityCount,
  DataImportWarning,
  MessageRole,
  SillyTavernImportCategoryAnalysis,
  SillyTavernImportCategoryId,
} from '@neotavern/contracts';
import type {
  CacheMetadataRepository,
  DataImportRepository,
  ImportResolutionPolicy,
  ImportedChatSession,
  ImportedLoreEntry,
  ImportedMessageInput,
  PluginRepository,
  ProviderConfigRepository,
} from '@neotavern/db';
import { AppError, ErrorCodes, isAppError } from '@neotavern/shared';
import { parseCharacterCard } from './characterCards.js';
import { storeAvatar, type CacheRecordSink } from './fileStore.js';
import type { DataPaths } from './paths.js';

type UnknownRecord = Record<string, unknown>;

const MAX_WARNINGS_RETURNED = 200;
const MAX_CHARACTER_BYTES = 25 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024 * 1024;
const MAX_WORLD_BYTES = 64 * 1024 * 1024;
const MAX_PRESET_BYTES = 32 * 1024 * 1024;
const MAX_CHAT_LINE_CHARS = 16 * 1024 * 1024;
const MAX_CONFLICTS_RETURNED = 200;

const ROOT_MARKERS = new Set([
  'characters',
  'chats',
  'worlds',
  'user avatars',
  'instruct',
  'context',
  'sysprompt',
  'reasoning',
  'koboldai settings',
  'novelai settings',
  'openai settings',
  'textgen settings',
  'groups',
  'group chats',
  'extensions',
  'themes',
]);

const PRESET_DIRECTORIES: ReadonlyArray<{ directory: string; kind: string }> = [
  { directory: 'instruct', kind: 'instruct' },
  { directory: 'context', kind: 'context' },
  { directory: 'sysprompt', kind: 'system-prompt' },
  { directory: 'reasoning', kind: 'reasoning' },
  { directory: 'KoboldAI Settings', kind: 'koboldai' },
  { directory: 'NovelAI Settings', kind: 'novelai' },
  { directory: 'OpenAI Settings', kind: 'openai' },
  { directory: 'TextGen Settings', kind: 'textgen' },
];

export interface SillyTavernImportRun {
  counts: DataImportCounts;
  warningCount: number;
  warnings: DataImportWarning[];
}

export interface SillyTavernImportInspection {
  categories: SillyTavernImportCategoryAnalysis[];
  conflictCount: number;
  conflicts: DataImportConflict[];
  warningCount: number;
  warnings: DataImportWarning[];
}

interface ImportContext {
  repository: DataImportRepository;
  paths: DataPaths;
  root: string;
  signal: AbortSignal;
  counts: DataImportCounts;
  warnings: WarningCollector;
  selectedCategories: ReadonlySet<SillyTavernImportCategoryId>;
  conflictPolicy: ImportResolutionPolicy;
  executionId: string;
  plugins?: PluginRepository;
  providerConfigs?: ProviderConfigRepository;
  cacheMetadata?: CacheMetadataRepository;
}

/** Thumbnail cache bookkeeping sink bound to the import context (ТЗ §11.3). */
function thumbnailRecorder(context: ImportContext): CacheRecordSink | undefined {
  const repository = context.cacheMetadata;
  if (!repository) return undefined;
  return (record) => repository.record(record);
}

class WarningCollector {
  readonly items: DataImportWarning[] = [];
  count = 0;

  add(code: string, path?: string, params?: Record<string, unknown>): void {
    this.count += 1;
    if (this.items.length >= MAX_WARNINGS_RETURNED) return;
    this.items.push({
      code,
      ...(path ? { path } : {}),
      ...(params ? { params } : {}),
    });
  }
}

/** Import all supported data below the best matching SillyTavern user root. */
export async function importSillyTavernData(options: {
  repository: DataImportRepository;
  paths: DataPaths;
  extractedRoot: string;
  signal: AbortSignal;
  categories?: readonly SillyTavernImportCategoryId[];
  conflictPolicy?: DataImportConflictPolicy;
  executionId?: string;
  /** Registries used by the apiSettings/legacyExtensions categories. */
  plugins?: PluginRepository;
  providerConfigs?: ProviderConfigRepository;
  /** Cache bookkeeping sink for generated thumbnails (ТЗ §11.3). */
  cacheMetadata?: CacheMetadataRepository;
}): Promise<SillyTavernImportRun> {
  const warnings = new WarningCollector();
  const root = await detectUserRoot(options.extractedRoot);
  if (!root) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'SILLYTAVERN_DATA_ROOT_NOT_FOUND' },
    });
  }

  const context: ImportContext = {
    repository: options.repository,
    paths: options.paths,
    root,
    signal: options.signal,
    counts: createCounts(),
    warnings,
    selectedCategories: new Set(options.categories ?? CATEGORY_IDS),
    conflictPolicy: options.conflictPolicy ?? 'preserve',
    executionId: options.executionId ?? 'default',
    plugins: options.plugins,
    providerConfigs: options.providerConfigs,
    cacheMetadata: options.cacheMetadata,
  };

  checkAborted(context.signal);
  await reportUnsupportedData(context);
  if (context.selectedCategories.has('personas')) await importPersonas(context);
  if (context.selectedCategories.has('characters')) await importCharacters(context);
  if (context.selectedCategories.has('chats')) await importChats(context);
  if (context.selectedCategories.has('lorebooks')) await importLorebooks(context);
  if (context.selectedCategories.has('presets')) await importPresets(context);
  if (context.selectedCategories.has('groups')) await importGroups(context);
  if (context.selectedCategories.has('backgrounds')) await importBackgrounds(context);
  if (context.selectedCategories.has('extensionSettings')) await importExtensionSettings(context);
  if (context.selectedCategories.has('apiSettings')) await importApiSettings(context);
  if (context.selectedCategories.has('legacyExtensions')) await importLegacyExtensions(context);
  if (context.selectedCategories.has('themes')) await importThemes(context);

  return {
    counts: context.counts,
    warningCount: warnings.count,
    warnings: warnings.items,
  };
}

/**
 * Inspect supported SillyTavern data without mutating the library.
 *
 * The inspection deliberately parses every supported record using the same
 * limits as the importer so the confirmation screen can report damaged data
 * and existing-library conflicts before a safety backup or import job exists.
 */
export async function analyzeSillyTavernData(options: {
  repository: DataImportRepository;
  extractedRoot: string;
  signal: AbortSignal;
}): Promise<SillyTavernImportInspection> {
  const warnings = new WarningCollector();
  const root = await detectUserRoot(options.extractedRoot);
  if (!root) {
    throw new AppError({
      code: ErrorCodes.BAD_REQUEST,
      params: { reason: 'SILLYTAVERN_DATA_ROOT_NOT_FOUND' },
    });
  }

  const context: AnalysisContext = {
    repository: options.repository,
    root,
    signal: options.signal,
    categories: createCategoryAnalysis(),
    warnings,
    conflictCount: 0,
    conflicts: [],
  };

  checkAborted(context.signal);
  await reportUnsupportedAnalysisData(context);
  await analyzePersonas(context);
  await analyzeCharacters(context);
  await analyzeChats(context);
  await analyzeLorebooks(context);
  await analyzePresets(context);
  await analyzeGroups(context);
  await analyzeBackgrounds(context);
  await analyzeExtensionSettings(context);
  await analyzeApiSettings(context);
  await analyzeLegacyExtensions(context);
  await analyzeThemes(context);

  return {
    categories: CATEGORY_IDS.map((id) => context.categories[id]),
    conflictCount: context.conflictCount,
    conflicts: context.conflicts,
    warningCount: warnings.count,
    warnings: warnings.items,
  };
}

const CATEGORY_IDS = [
  'characters',
  'chats',
  'personas',
  'lorebooks',
  'presets',
  'groups',
  'backgrounds',
  'extensionSettings',
  'apiSettings',
  'legacyExtensions',
  'themes',
] as const satisfies readonly SillyTavernImportCategoryId[];

interface AnalysisContext {
  repository: DataImportRepository;
  root: string;
  signal: AbortSignal;
  categories: Record<SillyTavernImportCategoryId, SillyTavernImportCategoryAnalysis>;
  warnings: WarningCollector;
  conflictCount: number;
  conflicts: DataImportConflict[];
}

function createCategoryAnalysis(): Record<
  SillyTavernImportCategoryId,
  SillyTavernImportCategoryAnalysis
> {
  return Object.fromEntries(
    CATEGORY_IDS.map((id) => [
      id,
      { id, discovered: 0, dependentRecords: 0, invalid: 0, conflicts: 0, sizeBytes: 0 },
    ]),
  ) as Record<SillyTavernImportCategoryId, SillyTavernImportCategoryAnalysis>;
}

async function reportUnsupportedAnalysisData(context: AnalysisContext): Promise<void> {
  const secret = await findChild(context.root, 'secrets.json', 'file');
  if (secret) context.warnings.add('SECRETS_SKIPPED', displayPath(context, secret));

  const settings = await findChild(context.root, 'settings.json', 'file');
  if (settings) {
    context.warnings.add('SETTINGS_PARTIALLY_IMPORTED', displayPath(context, settings), {
      importedSections: ['personas', 'extension_settings'],
    });
  }

  // SillyTavern server plugins live in the install directory (plugins/ next to
  // server.js), not in the user-data archive — nothing to import from the ZIP.
  const serverPlugins = await findChild(context.root, 'plugins', 'directory');
  if (serverPlugins) {
    context.warnings.add('UNSUPPORTED_DATA_SKIPPED', displayPath(context, serverPlugins), {
      kind: 'plugins',
      files: await countFiles(serverPlugins, context.signal),
    });
  }
}

async function analyzePersonas(context: AnalysisContext): Promise<void> {
  const category = context.categories.personas;
  const settingsPath = await findChild(context.root, 'settings.json', 'file');
  if (!settingsPath) return;

  try {
    category.sizeBytes += (await stat(settingsPath)).size;
    const settings = await readJsonRecord(settingsPath, MAX_SETTINGS_BYTES);
    const powerUser = recordValue(settings['power_user']) ?? settings;
    const personas = recordValue(powerUser['personas']);
    if (!personas) return;
    const descriptions = recordValue(powerUser['persona_descriptions']) ?? {};
    const avatarDirectory = await findChild(context.root, 'User Avatars', 'directory');
    const avatarFiles = avatarDirectory ? await indexFilesByName(avatarDirectory) : new Map();

    for (const [avatarId, rawName] of Object.entries(personas)) {
      checkAborted(context.signal);
      category.discovered += 1;
      if (typeof rawName !== 'string') {
        category.invalid += 1;
        context.warnings.add('PERSONA_INVALID', `settings.json#power_user.personas.${avatarId}`);
        continue;
      }

      const avatarPath = avatarFiles.get(avatarId.toLowerCase());
      if (avatarPath) {
        const avatarSize = (await stat(avatarPath)).size;
        category.sizeBytes += avatarSize;
        if (avatarSize > MAX_CHARACTER_BYTES) {
          category.invalid += 1;
          context.warnings.add(
            'PERSONA_AVATAR_INVALID',
            displayPath(context, avatarPath),
            errorParams(fileTooLarge(avatarSize, MAX_CHARACTER_BYTES)),
          );
        }
      } else {
        context.warnings.add('PERSONA_AVATAR_MISSING', avatarId);
      }

      const name = rawName.trim() || '[Unnamed Persona]';
      addConflict(
        context,
        'personas',
        personaKey(avatarId),
        `settings.json#power_user.personas.${avatarId}`,
        context.repository.findConflict({
          sourceKind: 'persona',
          sourceKey: personaKey(avatarId),
          name,
        }),
      );

      const descriptor = recordValue(descriptions[avatarId]);
      if (descriptions[avatarId] !== undefined && !descriptor) {
        category.invalid += 1;
        context.warnings.add(
          'PERSONA_DESCRIPTION_INVALID',
          `settings.json#power_user.persona_descriptions.${avatarId}`,
        );
      }
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    category.invalid += 1;
    context.warnings.add(
      'SETTINGS_INVALID',
      displayPath(context, settingsPath),
      errorParams(error),
    );
  }
}

async function analyzeCharacters(context: AnalysisContext): Promise<void> {
  const category = context.categories.characters;
  const directory = await findChild(context.root, 'characters', 'directory');
  if (!directory) return;

  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.png' && extension !== '.json') continue;
    const stem = basename(filePath, extension);
    if (extension === '.json' && (await siblingPngExists(filePath, stem))) continue;

    category.discovered += 1;
    const shownPath = displayPath(context, filePath);
    try {
      const info = await stat(filePath);
      category.sizeBytes += info.size;
      if (info.size > MAX_CHARACTER_BYTES) throw fileTooLarge(info.size, MAX_CHARACTER_BYTES);
      const bytes = await readFile(filePath);
      const parsed = parseCharacterCard(bytes, extension === '.png' ? 'png' : 'json');
      addConflict(
        context,
        'characters',
        characterKey(stem),
        shownPath,
        context.repository.findConflict({
          sourceKind: 'character',
          sourceKey: characterKey(stem),
          name: parsed.character.name,
        }),
      );
      for (const warning of parsed.warnings) context.warnings.add(warning, shownPath);
    } catch (error) {
      if (isAbort(error)) throw error;
      category.invalid += 1;
      context.warnings.add('CHARACTER_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

async function analyzeChats(context: AnalysisContext): Promise<void> {
  const category = context.categories.chats;
  const directory = await findChild(context.root, 'chats', 'directory');
  if (!directory) return;

  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.jsonl') continue;
    category.discovered += 1;
    const shownPath = displayPath(context, filePath);
    const relativeChatPath = normalizePath(relative(directory, filePath));
    const sourceKey = `chats/${relativeChatPath.toLowerCase()}`;
    try {
      category.sizeBytes += (await stat(filePath)).size;
      addConflict(
        context,
        'chats',
        sourceKey,
        shownPath,
        context.repository.findConflict({
          sourceKind: 'chat',
          sourceKey,
          name: basename(filePath, extname(filePath)),
        }),
      );

      let lineNumber = 0;
      let firstRecordSeen = false;
      let previousTimestamp = 0;
      const lines = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          checkAborted(context.signal);
          lineNumber += 1;
          if (line.trim().length === 0) continue;
          if (line.length > MAX_CHAT_LINE_CHARS) {
            category.invalid += 1;
            context.warnings.add('CHAT_LINE_TOO_LARGE', shownPath, { line: lineNumber });
            continue;
          }

          let record: UnknownRecord;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed)) throw new Error('chat line root must be an object');
            record = parsed;
          } catch {
            category.invalid += 1;
            context.warnings.add('CHAT_LINE_INVALID', shownPath, { line: lineNumber });
            continue;
          }
          if (!firstRecordSeen) {
            firstRecordSeen = true;
            if (recordValue(record['chat_metadata'])) continue;
          }

          const imported = parseChatMessage(record, previousTimestamp + 1);
          if (!imported) {
            category.invalid += 1;
            context.warnings.add('CHAT_MESSAGE_INVALID', shownPath, { line: lineNumber });
            continue;
          }
          previousTimestamp = imported.createdAt;
          category.dependentRecords += 1;
        }
      } finally {
        lines.close();
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      category.invalid += 1;
      context.warnings.add('CHAT_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

async function analyzeLorebooks(context: AnalysisContext): Promise<void> {
  const category = context.categories.lorebooks;
  const directory = await findChild(context.root, 'worlds', 'directory');
  if (!directory) return;

  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.json') continue;
    category.discovered += 1;
    const shownPath = displayPath(context, filePath);
    try {
      const info = await stat(filePath);
      category.sizeBytes += info.size;
      const bytes = await readBounded(filePath, MAX_WORLD_BYTES);
      const root = parseJsonRecord(bytes);
      const entriesRecord = recordValue(root['entries']) ?? {};
      for (const value of Object.values(entriesRecord)) {
        if (recordValue(value)) category.dependentRecords += 1;
        else {
          category.invalid += 1;
          context.warnings.add('LORE_ENTRY_INVALID', shownPath);
        }
      }
      const name =
        typeof root['name'] === 'string' ? root['name'] : basename(filePath, extname(filePath));
      const sourceKey = `worlds/${normalizePath(relative(directory, filePath)).toLowerCase()}`;
      addConflict(
        context,
        'lorebooks',
        sourceKey,
        shownPath,
        context.repository.findConflict({
          sourceKind: 'lorebook',
          sourceKey,
          name,
        }),
      );
    } catch (error) {
      if (isAbort(error)) throw error;
      category.invalid += 1;
      context.warnings.add('LOREBOOK_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

async function analyzePresets(context: AnalysisContext): Promise<void> {
  const category = context.categories.presets;
  for (const presetDirectory of PRESET_DIRECTORIES) {
    const directory = await findChild(context.root, presetDirectory.directory, 'directory');
    if (!directory) continue;
    for await (const filePath of walkFiles(directory)) {
      checkAborted(context.signal);
      if (extname(filePath).toLowerCase() !== '.json') continue;
      category.discovered += 1;
      const shownPath = displayPath(context, filePath);
      try {
        const info = await stat(filePath);
        category.sizeBytes += info.size;
        const data = parseJsonRecord(await readBounded(filePath, MAX_PRESET_BYTES));
        const name =
          typeof data['name'] === 'string' ? data['name'] : basename(filePath, extname(filePath));
        const sourceKey = `presets/${presetDirectory.kind}/${normalizePath(
          relative(directory, filePath),
        ).toLowerCase()}`;
        addConflict(
          context,
          'presets',
          sourceKey,
          shownPath,
          context.repository.findConflict({
            sourceKind: 'preset',
            sourceKey,
            name,
            presetKind: presetDirectory.kind,
          }),
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        category.invalid += 1;
        context.warnings.add('PRESET_IMPORT_FAILED', shownPath, errorParams(error));
      }
    }
  }
}

function addConflict(
  context: AnalysisContext,
  categoryId: SillyTavernImportCategoryId,
  sourceKey: string,
  path: string,
  conflict: ReturnType<DataImportRepository['findConflict']>,
): void {
  if (!conflict) return;
  context.conflictCount += 1;
  context.categories[categoryId].conflicts += 1;
  if (context.conflicts.length >= MAX_CONFLICTS_RETURNED) return;
  const safePolicies: DataImportConflictPolicy[] =
    categoryId === 'chats' ? ['skip', 'copy', 'replace'] : ['skip', 'copy', 'merge', 'replace'];
  context.conflicts.push({
    category: categoryId,
    sourceKey,
    path,
    kind: conflict.kind,
    targetId: conflict.id,
    targetName: conflict.name,
    safePolicies,
  });
}

async function detectUserRoot(extractedRoot: string): Promise<string | null> {
  const scores = new Map<string, number>();

  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ROOT_MARKERS.has(entry.name.toLowerCase())) {
          scores.set(directory, (scores.get(directory) ?? 0) + 1);
        }
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'settings.json') {
        scores.set(directory, (scores.get(directory) ?? 0) + 3);
      }
    }
  };

  await visit(extractedRoot);
  const candidates = [...scores.entries()];
  candidates.sort(([leftPath, leftScore], [rightPath, rightScore]) => {
    const leftDefault = basename(leftPath).toLowerCase() === 'default-user' ? 2 : 0;
    const rightDefault = basename(rightPath).toLowerCase() === 'default-user' ? 2 : 0;
    const scoreDelta = rightScore + rightDefault - (leftScore + leftDefault);
    if (scoreDelta !== 0) return scoreDelta;
    return pathDepth(leftPath) - pathDepth(rightPath);
  });
  return candidates[0]?.[0] ?? null;
}

async function reportUnsupportedData(context: ImportContext): Promise<void> {
  const secret = await findChild(context.root, 'secrets.json', 'file');
  if (secret) context.warnings.add('SECRETS_SKIPPED', displayPath(context, secret));

  const settings = await findChild(context.root, 'settings.json', 'file');
  if (settings) {
    context.warnings.add('SETTINGS_PARTIALLY_IMPORTED', displayPath(context, settings), {
      importedSections: ['personas', 'extension_settings'],
    });
  }

  // Server plugins live in the ST install directory, not the user archive.
  const serverPlugins = await findChild(context.root, 'plugins', 'directory');
  if (serverPlugins) {
    context.warnings.add('UNSUPPORTED_DATA_SKIPPED', displayPath(context, serverPlugins), {
      kind: 'plugins',
      files: await countFiles(serverPlugins, context.signal),
    });
  }
}

async function importPersonas(context: ImportContext): Promise<void> {
  const settingsPath = await findChild(context.root, 'settings.json', 'file');
  if (!settingsPath) return;

  let settings: UnknownRecord;
  try {
    settings = await readJsonRecord(settingsPath, MAX_SETTINGS_BYTES);
  } catch (error) {
    context.warnings.add(
      'SETTINGS_INVALID',
      displayPath(context, settingsPath),
      errorParams(error),
    );
    context.counts.personas.skipped += 1;
    return;
  }

  const powerUser = recordValue(settings['power_user']) ?? settings;
  const personas = recordValue(powerUser['personas']);
  if (!personas) return;
  const descriptions = recordValue(powerUser['persona_descriptions']) ?? {};
  const defaultPersona =
    typeof powerUser['default_persona'] === 'string' ? powerUser['default_persona'] : null;
  const avatarDirectory = await findChild(context.root, 'User Avatars', 'directory');
  const avatarFiles = avatarDirectory ? await indexFilesByName(avatarDirectory) : new Map();

  for (const [avatarId, rawName] of Object.entries(personas)) {
    checkAborted(context.signal);
    if (typeof rawName !== 'string') {
      context.counts.personas.skipped += 1;
      context.warnings.add('PERSONA_INVALID', `settings.json#power_user.personas.${avatarId}`);
      continue;
    }

    const descriptor = recordValue(descriptions[avatarId]) ?? {};
    const descriptorHash = sha256(
      Buffer.from(JSON.stringify({ avatarId, name: rawName, descriptor })),
    );
    let avatar: string | null = null;
    let avatarHash: string | null = null;
    const avatarPath = avatarFiles.get(avatarId.toLowerCase());
    if (avatarPath) {
      try {
        const info = await stat(avatarPath);
        if (info.size > MAX_CHARACTER_BYTES) throw fileTooLarge(info.size, MAX_CHARACTER_BYTES);
        const bytes = await readFile(avatarPath);
        const stored = await storeAvatar(bytes, context.paths, 256, thumbnailRecorder(context));
        avatar = stored.thumbnailUrl;
        avatarHash = stored.hash;
      } catch (error) {
        context.warnings.add(
          'PERSONA_AVATAR_INVALID',
          displayPath(context, avatarPath),
          errorParams(error),
        );
      }
    } else {
      context.warnings.add('PERSONA_AVATAR_MISSING', avatarId);
    }

    const sourceHash = sha256(Buffer.from(`${descriptorHash}:${avatarHash ?? ''}`));
    try {
      const result = context.repository.importPersona(
        {
          sourceKind: 'persona',
          sourceKey: effectiveSourceKey(context, personaKey(avatarId)),
          sourceHash,
          metadata: {
            source: 'sillytavern',
            avatarId,
            descriptor,
          },
        },
        {
          name: rawName.trim() || '[Unnamed Persona]',
          description:
            typeof descriptor['description'] === 'string' ? descriptor['description'] : '',
          avatar,
          isDefault: avatarId === defaultPersona,
        },
        context.conflictPolicy,
      );
      increment(context.counts.personas, result.created);
    } catch (error) {
      context.counts.personas.skipped += 1;
      context.warnings.add('PERSONA_IMPORT_FAILED', avatarId, errorParams(error));
    }
  }
}

async function importCharacters(context: ImportContext): Promise<void> {
  const charactersDirectory = await findChild(context.root, 'characters', 'directory');
  if (!charactersDirectory) return;

  for await (const filePath of walkFiles(charactersDirectory)) {
    checkAborted(context.signal);
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.png' && extension !== '.json') continue;
    const stem = basename(filePath, extension);
    if (extension === '.json' && (await siblingPngExists(filePath, stem))) continue;

    const shownPath = displayPath(context, filePath);
    try {
      const info = await stat(filePath);
      if (info.size > MAX_CHARACTER_BYTES) throw fileTooLarge(info.size, MAX_CHARACTER_BYTES);
      const bytes = await readFile(filePath);
      const sourceHash = sha256(bytes);
      const kind = extension === '.png' ? 'png' : 'json';
      const parsed = parseCharacterCard(bytes, kind);
      let avatar: string | null = null;
      if (kind === 'png') {
        avatar = (await storeAvatar(bytes, context.paths, 256, thumbnailRecorder(context)))
          .thumbnailUrl;
      }

      const existingSt2 = recordValue(parsed.character.ext?.['_st2']) ?? {};
      const result = context.repository.importCharacter(
        {
          sourceKind: 'character',
          sourceKey: effectiveSourceKey(context, characterKey(stem)),
          sourceHash,
          metadata: { source: 'sillytavern', path: shownPath, format: parsed.sourceFormat },
        },
        {
          ...parsed.character,
          ext: {
            ...(parsed.character.ext ?? {}),
            _st2: {
              ...existingSt2,
              migrationSource: 'sillytavern',
              sourcePath: shownPath,
              sourceHash,
            },
          },
        },
        avatar,
        context.conflictPolicy,
      );
      increment(context.counts.characters, result.created);
      for (const warning of parsed.warnings) {
        context.warnings.add(warning, shownPath);
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.characters.skipped += 1;
      context.warnings.add('CHARACTER_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

async function importChats(context: ImportContext): Promise<void> {
  const chatsDirectory = await findChild(context.root, 'chats', 'directory');
  if (!chatsDirectory) return;

  for await (const filePath of walkFiles(chatsDirectory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.jsonl') continue;
    await importChat(context, chatsDirectory, filePath);
  }
}

async function importChat(
  context: ImportContext,
  chatsDirectory: string,
  filePath: string,
): Promise<void> {
  const shownPath = displayPath(context, filePath);
  const relativeChatPath = normalizePath(relative(chatsDirectory, filePath));
  const parts = relativeChatPath.split('/');
  const characterStem = parts.length > 1 ? parts[0] : null;
  const sourceKey = effectiveSourceKey(context, `chats/${relativeChatPath.toLowerCase()}`);
  let session: ImportedChatSession | null = null;
  let sourceHash = '';

  try {
    sourceHash = await hashFile(filePath, context.signal);
    const first = await readFirstRecord(filePath, context.signal);
    const header = first && recordValue(first['chat_metadata']) ? first : null;
    const metadata = header ? (recordValue(header['chat_metadata']) ?? {}) : {};
    const personaAvatar = typeof metadata['persona'] === 'string' ? metadata['persona'] : null;
    const characterId = characterStem
      ? context.repository.findArtifactTarget(
          'character',
          effectiveSourceKey(context, characterKey(characterStem)),
        )
      : null;
    const personaId = personaAvatar
      ? context.repository.findArtifactTarget(
          'persona',
          effectiveSourceKey(context, personaKey(personaAvatar)),
        )
      : null;
    if (characterStem && !characterId) {
      context.warnings.add('CHAT_CHARACTER_NOT_FOUND', shownPath, { characterStem });
    }
    if (personaAvatar && !personaId) {
      context.warnings.add('CHAT_PERSONA_NOT_FOUND', shownPath, { personaAvatar });
    }

    const info = await stat(filePath);
    const fallbackTime = Math.max(0, Math.round(info.birthtimeMs || info.mtimeMs));
    session = context.repository.beginChatImport(
      {
        sourceKind: 'chat',
        sourceKey,
        sourceHash,
        characterId,
        personaId,
        title: basename(filePath, extname(filePath)).slice(0, 500),
        createdAt: fallbackTime,
        updatedAt: Math.max(fallbackTime, Math.round(info.mtimeMs)),
        metadata: {
          source: 'sillytavern',
          path: shownPath,
          chatMetadata: metadata,
        },
      },
      context.conflictPolicy,
    );
    if (!session.created) {
      context.counts.chats.reused += 1;
      context.counts.messages.reused += session.messageCount;
      return;
    }

    let parentId: string | null = null;
    let messageCount = 0;
    let skippedMessages = 0;
    let previousTimestamp = fallbackTime - 1;
    let lineNumber = 0;
    let firstRecordSeen = false;
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      checkAborted(context.signal);
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      if (line.length > MAX_CHAT_LINE_CHARS) {
        skippedMessages += 1;
        context.warnings.add('CHAT_LINE_TOO_LARGE', shownPath, { line: lineNumber });
        continue;
      }

      let record: UnknownRecord;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error('chat line root must be an object');
        record = parsed;
      } catch {
        skippedMessages += 1;
        context.warnings.add('CHAT_LINE_INVALID', shownPath, { line: lineNumber });
        continue;
      }
      if (!firstRecordSeen) {
        firstRecordSeen = true;
        if (recordValue(record['chat_metadata'])) continue;
      }

      const imported = parseChatMessage(record, previousTimestamp + 1);
      if (!imported) {
        skippedMessages += 1;
        context.warnings.add('CHAT_MESSAGE_INVALID', shownPath, { line: lineNumber });
        continue;
      }
      previousTimestamp = imported.createdAt;
      parentId = context.repository.appendChatMessage(session, parentId, imported);
      messageCount += 1;
    }

    context.repository.finishChatImport(
      sourceKey,
      session.id,
      messageCount,
      messageCount > 0 ? previousTimestamp : fallbackTime,
      session.replacedId,
    );
    context.counts.chats.imported += 1;
    context.counts.messages.imported += messageCount;
    context.counts.messages.skipped += skippedMessages;
  } catch (error) {
    if (session?.created) {
      context.repository.abortChatImport(sourceKey, session.id, session.replacedId, sourceHash);
    }
    if (isAbort(error)) throw error;
    context.counts.chats.skipped += 1;
    context.warnings.add('CHAT_IMPORT_FAILED', shownPath, errorParams(error));
  }
}

async function importLorebooks(context: ImportContext): Promise<void> {
  const worldsDirectory = await findChild(context.root, 'worlds', 'directory');
  if (!worldsDirectory) return;

  for await (const filePath of walkFiles(worldsDirectory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.json') continue;
    const shownPath = displayPath(context, filePath);
    try {
      const bytes = await readBounded(filePath, MAX_WORLD_BYTES);
      const sourceHash = sha256(bytes);
      const root = parseJsonRecord(bytes);
      const entriesRecord = recordValue(root['entries']) ?? {};
      const entries: ImportedLoreEntry[] = [];
      for (const value of Object.values(entriesRecord)) {
        const entry = recordValue(value);
        if (!entry) {
          context.counts.loreEntries.skipped += 1;
          context.warnings.add('LORE_ENTRY_INVALID', shownPath);
          continue;
        }
        entries.push(parseLoreEntry(entry));
      }

      const result = context.repository.importLorebook(
        {
          sourceKind: 'lorebook',
          sourceKey: effectiveSourceKey(
            context,
            `worlds/${normalizePath(relative(worldsDirectory, filePath)).toLowerCase()}`,
          ),
          sourceHash,
          name:
            typeof root['name'] === 'string' ? root['name'] : basename(filePath, extname(filePath)),
          description: typeof root['description'] === 'string' ? root['description'] : '',
          entries,
          metadata: {
            source: 'sillytavern',
            path: shownPath,
            sourceRoot: omit(root, ['entries', 'name', 'description']),
          },
        },
        context.conflictPolicy,
      );
      increment(context.counts.lorebooks, result.created);
      if (result.created) context.counts.loreEntries.imported += entries.length;
      else context.counts.loreEntries.reused += entries.length;
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.lorebooks.skipped += 1;
      context.warnings.add('LOREBOOK_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

async function importPresets(context: ImportContext): Promise<void> {
  for (const presetDirectory of PRESET_DIRECTORIES) {
    const directory = await findChild(context.root, presetDirectory.directory, 'directory');
    if (!directory) continue;
    for await (const filePath of walkFiles(directory)) {
      checkAborted(context.signal);
      if (extname(filePath).toLowerCase() !== '.json') continue;
      const shownPath = displayPath(context, filePath);
      try {
        const bytes = await readBounded(filePath, MAX_PRESET_BYTES);
        const sourceHash = sha256(bytes);
        const data = parseJsonRecord(bytes);
        const requestedName =
          typeof data['name'] === 'string' ? data['name'] : basename(filePath, extname(filePath));
        const result = context.repository.importPreset(
          {
            sourceKind: 'preset',
            sourceKey: effectiveSourceKey(
              context,
              `presets/${presetDirectory.kind}/${normalizePath(
                relative(directory, filePath),
              ).toLowerCase()}`,
            ),
            sourceHash,
            metadata: { source: 'sillytavern', path: shownPath },
          },
          presetDirectory.kind,
          requestedName,
          data,
          context.conflictPolicy,
        );
        increment(context.counts.presets, result.created);
      } catch (error) {
        if (isAbort(error)) throw error;
        context.counts.presets.skipped += 1;
        context.warnings.add('PRESET_IMPORT_FAILED', shownPath, errorParams(error));
      }
    }
  }
}

// --- Groups / group chats (ТЗ §16). Groups become chats carrying the group
// record in artifact metadata; matching `group chats/<id>.jsonl` transcripts
// are attached as messages. ---

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_BACKGROUND_BYTES = 64 * 1024 * 1024;

async function analyzeGroups(context: AnalysisContext): Promise<void> {
  const category = context.categories.groups;
  const directory = await findChild(context.root, 'groups', 'directory');
  if (!directory) return;
  const chatDirectory = await findChild(context.root, 'group chats', 'directory');
  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.json') continue;
    category.discovered += 1;
    category.sizeBytes += (await stat(filePath)).size;
    try {
      const record = parseJsonRecord(await readBounded(filePath, MAX_PRESET_BYTES));
      if (typeof record['name'] !== 'string' || record['name'].trim().length === 0) {
        category.invalid += 1;
      }
      const groupId = typeof record['id'] === 'string' ? record['id'] : null;
      if (groupId && chatDirectory) {
        const transcript = await findChild(chatDirectory, `${groupId}.jsonl`, 'file');
        if (transcript) {
          category.dependentRecords += await countJsonlLines(transcript, context.signal);
          category.sizeBytes += (await stat(transcript)).size;
        }
      }
    } catch {
      category.invalid += 1;
    }
  }
}

async function importGroups(context: ImportContext): Promise<void> {
  const directory = await findChild(context.root, 'groups', 'directory');
  if (!directory) return;
  const chatDirectory = await findChild(context.root, 'group chats', 'directory');

  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (extname(filePath).toLowerCase() !== '.json') continue;
    const shownPath = displayPath(context, filePath);
    try {
      const bytes = await readBounded(filePath, MAX_PRESET_BYTES);
      const record = parseJsonRecord(bytes);
      const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
      if (name.length === 0) {
        context.counts.groups.skipped += 1;
        context.warnings.add('GROUP_INVALID', shownPath);
        continue;
      }
      const groupId =
        typeof record['id'] === 'string' && record['id'].length > 0
          ? record['id']
          : basename(filePath, extname(filePath));
      const info = await stat(filePath);
      const time = Math.max(0, Math.round(info.mtimeMs));
      const session = context.repository.beginChatImport(
        {
          sourceKind: 'sillytavern-group',
          sourceKey: effectiveSourceKey(context, `groups/${groupId}`.toLowerCase()),
          sourceHash: sha256(bytes),
          characterId: null,
          personaId: null,
          title: name.slice(0, 500),
          createdAt: time,
          updatedAt: time,
          metadata: { source: 'sillytavern', path: shownPath, group: record },
        },
        context.conflictPolicy,
      );
      if (!session.created) {
        context.counts.groups.reused += 1;
        context.counts.messages.reused += session.messageCount;
        continue;
      }
      context.counts.groups.imported += 1;

      const transcript = chatDirectory
        ? await findChild(chatDirectory, `${groupId}.jsonl`, 'file')
        : null;
      if (transcript) {
        context.counts.messages.imported += await appendGroupTranscript(
          context,
          session,
          transcript,
          time,
        );
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.groups.skipped += 1;
      context.warnings.add('GROUP_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

/** Attach a group-chat JSONL transcript to a freshly created group chat. */
async function appendGroupTranscript(
  context: ImportContext,
  session: ImportedChatSession,
  transcriptPath: string,
  minimumTimestamp: number,
): Promise<number> {
  let parentId: string | null = null;
  let imported = 0;
  let previousTimestamp = minimumTimestamp - 1;
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    checkAborted(context.signal);
    if (line.trim().length === 0) continue;
    if (line.length > MAX_CHAT_LINE_CHARS) continue;
    let record: UnknownRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    const message = parseChatMessage(record, previousTimestamp + 1);
    if (!message) continue;
    previousTimestamp = message.createdAt;
    parentId = context.repository.appendChatMessage(session, parentId, message);
    imported += 1;
  }
  return imported;
}

// --- Backgrounds (ТЗ §16): originals copied into data/files/backgrounds. ---

async function analyzeBackgrounds(context: AnalysisContext): Promise<void> {
  const category = context.categories.backgrounds;
  const directory = await findChild(context.root, 'backgrounds', 'directory');
  if (!directory) return;
  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    category.discovered += 1;
    const size = (await stat(filePath)).size;
    category.sizeBytes += size;
    if (size > MAX_BACKGROUND_BYTES) category.invalid += 1;
  }
}

async function importBackgrounds(context: ImportContext): Promise<void> {
  const directory = await findChild(context.root, 'backgrounds', 'directory');
  if (!directory) return;
  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const shownPath = displayPath(context, filePath);
    try {
      const info = await stat(filePath);
      if (info.size > MAX_BACKGROUND_BYTES) {
        context.counts.backgrounds.skipped += 1;
        context.warnings.add(
          'BACKGROUND_IMPORT_FAILED',
          shownPath,
          errorParams(fileTooLarge(info.size, MAX_BACKGROUND_BYTES)),
        );
        continue;
      }
      const target = join(context.paths.backgrounds, basename(filePath));
      if (await pathExists(target)) {
        context.counts.backgrounds.reused += 1;
        continue;
      }
      await copyFile(filePath, target);
      context.counts.backgrounds.imported += 1;
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.backgrounds.skipped += 1;
      context.warnings.add('BACKGROUND_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

// --- Extension settings (ТЗ §16): settings.json#extension_settings →
// the legacy extension-settings store the compat layer already serves. ---

async function analyzeExtensionSettings(context: AnalysisContext): Promise<void> {
  const category = context.categories.extensionSettings;
  const settingsPath = await findChild(context.root, 'settings.json', 'file');
  if (!settingsPath) return;
  try {
    const settings = await readJsonRecord(settingsPath, MAX_SETTINGS_BYTES);
    const extensionSettings = recordValue(settings['extension_settings']);
    if (!extensionSettings) return;
    const namespaces = Object.keys(extensionSettings);
    category.discovered += namespaces.length;
    category.sizeBytes += (await stat(settingsPath)).size;
  } catch {
    // Malformed settings.json is reported by the persona analysis path.
  }
}

async function importExtensionSettings(context: ImportContext): Promise<void> {
  const settingsPath = await findChild(context.root, 'settings.json', 'file');
  if (!settingsPath) return;
  let settings: UnknownRecord;
  try {
    settings = await readJsonRecord(settingsPath, MAX_SETTINGS_BYTES);
  } catch (error) {
    context.warnings.add(
      'EXTENSION_SETTINGS_IMPORT_FAILED',
      displayPath(context, settingsPath),
      errorParams(error),
    );
    return;
  }
  const extensionSettings = recordValue(settings['extension_settings']);
  if (!extensionSettings) return;
  for (const [namespace, value] of Object.entries(extensionSettings)) {
    checkAborted(context.signal);
    if (!isRecord(value)) {
      context.counts.extensionSettings.skipped += 1;
      continue;
    }
    try {
      const existed = context.repository.findLegacySettings(namespace) !== null;
      context.repository.upsertLegacySettings(namespace, value);
      if (existed) context.counts.extensionSettings.reused += 1;
      else context.counts.extensionSettings.imported += 1;
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.extensionSettings.skipped += 1;
      context.warnings.add('EXTENSION_SETTINGS_IMPORT_FAILED', namespace, errorParams(error));
    }
  }
}

// --- API settings (ТЗ §16): OpenAI-compatible provider configs. Secrets are
// NOT imported (secrets.json is skipped); configs land disabled. ---

async function analyzeApiSettings(context: AnalysisContext): Promise<void> {
  const category = context.categories.apiSettings;
  for (const presetDirectory of PRESET_DIRECTORIES) {
    if (presetDirectory.kind !== 'openai') continue;
    const directory = await findChild(context.root, presetDirectory.directory, 'directory');
    if (!directory) continue;
    for await (const filePath of walkFiles(directory)) {
      checkAborted(context.signal);
      if (extname(filePath).toLowerCase() !== '.json') continue;
      category.discovered += 1;
      category.sizeBytes += (await stat(filePath)).size;
    }
  }
}

async function importApiSettings(context: ImportContext): Promise<void> {
  if (!context.providerConfigs) {
    context.warnings.add('API_SETTINGS_REQUIRES_REGISTRY');
    return;
  }
  const existingNames = new Set(
    (await context.providerConfigs.list()).map((entry) => entry.name.toLowerCase()),
  );
  for (const presetDirectory of PRESET_DIRECTORIES) {
    if (presetDirectory.kind !== 'openai') continue;
    const directory = await findChild(context.root, presetDirectory.directory, 'directory');
    if (!directory) continue;
    for await (const filePath of walkFiles(directory)) {
      checkAborted(context.signal);
      if (extname(filePath).toLowerCase() !== '.json') continue;
      const shownPath = displayPath(context, filePath);
      try {
        const data = parseJsonRecord(await readBounded(filePath, MAX_PRESET_BYTES));
        const name = `SillyTavern: ${basename(filePath, extname(filePath))}`.slice(0, 200);
        if (existingNames.has(name.toLowerCase())) {
          context.counts.apiSettings.reused += 1;
          continue;
        }
        const model =
          typeof data['openai_model'] === 'string' && data['openai_model'].length > 0
            ? data['openai_model']
            : typeof data['model'] === 'string'
              ? data['model']
              : null;
        const perModel = recordValue(data['api_url_per_model']);
        const baseUrl = (
          model && perModel && typeof perModel[model] === 'string'
            ? perModel[model]
            : typeof data['api_url'] === 'string'
              ? data['api_url']
              : null
        ) as string | null;
        await context.providerConfigs.create({
          kind: 'openai-compatible',
          name,
          baseUrl,
          model,
          enabled: false,
          settings: data,
        });
        existingNames.add(name.toLowerCase());
        context.counts.apiSettings.imported += 1;
        context.warnings.add('API_SETTINGS_NO_SECRETS', shownPath);
      } catch (error) {
        if (isAbort(error)) throw error;
        context.counts.apiSettings.skipped += 1;
        context.warnings.add('API_SETTINGS_IMPORT_FAILED', shownPath, errorParams(error));
      }
    }
  }
}

// --- Legacy UI extensions (ТЗ §16): copied as legacy-trusted plugin packages
// in needs-consent state; the user confirms before any code executes. ---

async function analyzeLegacyExtensions(context: AnalysisContext): Promise<void> {
  const category = context.categories.legacyExtensions;
  const directory = await findChild(context.root, 'extensions', 'directory');
  if (!directory) return;
  for await (const entryPath of childDirectories(directory)) {
    checkAborted(context.signal);
    const entry = await findChild(entryPath, 'index.js', 'file');
    if (!entry) continue;
    category.discovered += 1;
    category.sizeBytes += await directorySize(entryPath, context.signal);
  }
}

async function importLegacyExtensions(context: ImportContext): Promise<void> {
  const directory = await findChild(context.root, 'extensions', 'directory');
  if (!directory) return;
  if (!context.plugins) {
    context.warnings.add('LEGACY_EXTENSIONS_REQUIRE_REGISTRY');
    return;
  }
  for await (const entryPath of childDirectories(directory)) {
    checkAborted(context.signal);
    const entry = await findChild(entryPath, 'index.js', 'file');
    if (!entry) continue;
    const folderName = basename(entryPath);
    const shownPath = displayPath(context, entryPath);
    try {
      const id = `legacy.${folderName.toLowerCase().replace(/[^a-z0-9._-]+/giu, '-')}`;
      const packageRoot = join(context.paths.plugins, id, 'package');
      await cp(entryPath, packageRoot, { recursive: true, force: true });
      const result = context.plugins.install({
        id,
        name: folderName.slice(0, 200),
        version: '0.0.0',
        manifest: {
          id,
          name: folderName,
          version: '0.0.0',
          apiVersion: 2,
          legacy: { frontend: 'index.js' },
        },
        requestedPermissions: ['legacy.trusted'],
      });
      if (result.replaced) context.counts.legacyExtensions.reused += 1;
      else context.counts.legacyExtensions.imported += 1;
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.legacyExtensions.skipped += 1;
      context.warnings.add('LEGACY_EXTENSION_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

// --- Themes / custom CSS (ТЗ §16): raw files preserved under legacy-themes;
// applying them to the new Theme SDK is a deliberate manual step. ---

async function analyzeThemes(context: AnalysisContext): Promise<void> {
  const category = context.categories.themes;
  const directory = await findChild(context.root, 'themes', 'directory');
  if (!directory) return;
  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.css' && extension !== '.json') continue;
    category.discovered += 1;
    category.sizeBytes += (await stat(filePath)).size;
  }
}

async function importThemes(context: ImportContext): Promise<void> {
  const directory = await findChild(context.root, 'themes', 'directory');
  if (!directory) return;
  const target = join(context.paths.root, 'legacy-themes');
  for await (const filePath of walkFiles(directory)) {
    checkAborted(context.signal);
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.css' && extension !== '.json') continue;
    const shownPath = displayPath(context, filePath);
    try {
      await mkdir(target, { recursive: true });
      const destination = join(target, basename(filePath));
      if (await pathExists(destination)) {
        context.counts.themes.reused += 1;
        continue;
      }
      await copyFile(filePath, destination);
      context.counts.themes.imported += 1;
    } catch (error) {
      if (isAbort(error)) throw error;
      context.counts.themes.skipped += 1;
      context.warnings.add('THEME_IMPORT_FAILED', shownPath, errorParams(error));
    }
  }
}

function parseChatMessage(
  record: UnknownRecord,
  minimumTimestamp: number,
): ImportedMessageInput | null {
  const content =
    typeof record['mes'] === 'string'
      ? record['mes']
      : typeof recordValue(record['extra'])?.['display_text'] === 'string'
        ? (recordValue(record['extra'])?.['display_text'] as string)
        : null;
  if (content === null) return null;

  const role: MessageRole =
    record['is_system'] === true
      ? 'system'
      : record['is_user'] === true
        ? 'user'
        : recordValue(record['extra'])?.['type'] === 'tool'
          ? 'tool'
          : 'assistant';
  const parsedTimestamp = parseTimestamp(record['send_date']);
  const createdAt = Math.max(minimumTimestamp, parsedTimestamp ?? minimumTimestamp);
  const variants = Array.isArray(record['swipes'])
    ? record['swipes'].filter((value): value is string => typeof value === 'string')
    : [];

  return {
    role,
    content,
    name: typeof record['name'] === 'string' ? record['name'] : null,
    createdAt,
    variants,
    meta: {
      sillyTavern: omit(record, ['mes', 'swipes']),
    },
  };
}

function parseLoreEntry(entry: UnknownRecord): ImportedLoreEntry {
  return {
    keys: stringArray(entry['key'] ?? entry['keys']),
    secondaryKeys: stringArray(entry['keysecondary'] ?? entry['secondary_keys']),
    content: typeof entry['content'] === 'string' ? entry['content'] : '',
    enabled: entry['disable'] !== true && entry['enabled'] !== false,
    position: numberValue(entry['order'] ?? entry['position'], 0),
    constant: entry['constant'] === true,
    selective: entry['selective'] === true,
    metadata: omit(entry, [
      'key',
      'keys',
      'keysecondary',
      'secondary_keys',
      'content',
      'disable',
      'enabled',
      'order',
      'position',
      'constant',
      'selective',
    ]),
  };
}

async function readFirstRecord(path: string, signal: AbortSignal): Promise<UnknownRecord | null> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      checkAborted(signal);
      if (line.trim().length === 0) continue;
      if (line.length > MAX_CHAT_LINE_CHARS) return null;
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? parsed : null;
    }
    return null;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  } finally {
    lines.close();
  }
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    checkAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function readJsonRecord(path: string, maxBytes: number): Promise<UnknownRecord> {
  return parseJsonRecord(await readBounded(path, maxBytes));
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(path);
  if (info.size > maxBytes) throw fileTooLarge(info.size, maxBytes);
  return readFile(path);
}

function parseJsonRecord(bytes: Buffer): UnknownRecord {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(parsed)) throw new Error('JSON root must be an object');
  return parsed;
}

async function findChild(
  directory: string,
  requestedName: string,
  kind: 'file' | 'directory',
): Promise<string | null> {
  const handle = await opendir(directory);
  const lowerName = requestedName.toLowerCase();
  for await (const entry of handle) {
    if (entry.name.toLowerCase() !== lowerName) continue;
    if (kind === 'file' ? entry.isFile() : entry.isDirectory()) {
      return join(directory, entry.name);
    }
  }
  return null;
}

async function indexFilesByName(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for await (const filePath of walkFiles(directory)) {
    result.set(basename(filePath).toLowerCase(), filePath);
  }
  return result;
}

async function* walkFiles(directory: string): AsyncGenerator<string> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

async function countFiles(directory: string, signal?: AbortSignal): Promise<number> {
  let count = 0;
  for await (const _file of walkFiles(directory)) {
    if (signal) checkAborted(signal);
    count += 1;
  }
  return count;
}

async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

/** Immediate subdirectories of a directory (not recursive). */
async function* childDirectories(directory: string): AsyncGenerator<string, void, unknown> {
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (entry.isDirectory()) yield join(directory, entry.name);
    }
  } finally {
    await entries.close();
  }
}

/** Total byte size of a directory tree (walks files recursively). */
async function directorySize(directory: string, signal: AbortSignal): Promise<number> {
  let total = 0;
  for await (const filePath of walkFiles(directory)) {
    checkAborted(signal);
    total += (await stat(filePath)).size;
  }
  return total;
}

/** Number of non-empty lines in a JSONL file (dependent-record estimate). */
async function countJsonlLines(filePath: string, signal: AbortSignal): Promise<number> {
  let count = 0;
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    checkAborted(signal);
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

async function siblingPngExists(jsonPath: string, stem: string): Promise<boolean> {
  const pngPath = join(dirname(jsonPath), `${stem}.png`);
  const info = await stat(pngPath).catch(() => null);
  return info?.isFile() ?? false;
}

function createCounts(): DataImportCounts {
  const count = (): DataImportEntityCount => ({ imported: 0, reused: 0, skipped: 0 });
  return {
    characters: count(),
    chats: count(),
    messages: count(),
    personas: count(),
    lorebooks: count(),
    loreEntries: count(),
    presets: count(),
    groups: count(),
    backgrounds: count(),
    extensionSettings: count(),
    apiSettings: count(),
    legacyExtensions: count(),
    themes: count(),
  };
}

function increment(counts: DataImportEntityCount, created: boolean): void {
  if (created) counts.imported += 1;
  else counts.reused += 1;
}

function characterKey(stem: string): string {
  return `characters/${stem.trim().toLowerCase()}`;
}

function personaKey(avatarId: string): string {
  return `personas/${avatarId.trim().toLowerCase()}`;
}

function effectiveSourceKey(context: ImportContext, sourceKey: string): string {
  return context.conflictPolicy === 'copy' ? `${sourceKey}#copy:${context.executionId}` : sourceKey;
}

function displayPath(context: Pick<ImportContext, 'root'>, path: string): string {
  return normalizePath(relative(context.root, path));
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function pathDepth(path: string): number {
  return normalizePath(path).split('/').filter(Boolean).length;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

function recordValue(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function omit(record: UnknownRecord, keys: readonly string[]): UnknownRecord {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.has(key)));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileTooLarge(actualBytes: number, limitBytes: number): AppError {
  return new AppError({
    code: ErrorCodes.FILE_TOO_LARGE,
    params: { actualBytes, limitBytes },
  });
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AppError({ code: ErrorCodes.ABORTED });
  }
}

function isAbort(error: unknown): boolean {
  return isAppError(error) && error.code === ErrorCodes.ABORTED;
}

function errorParams(error: unknown): Record<string, unknown> {
  if (isAppError(error)) return { code: error.code, ...error.params };
  return { reason: 'INVALID_SOURCE_DATA' };
}
