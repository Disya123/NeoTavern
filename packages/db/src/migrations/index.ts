import type { Migration } from './types.js';
import { migration as init } from './0000_init.js';
import { migration as contentAndImports } from './0001_content_and_imports.js';
import { migration as importArtifacts } from './0002_import_artifacts.js';
import { migration as repeatableImportJobs } from './0003_repeatable_import_jobs.js';
import { migration as pluginConsent } from './0004_plugin_consent.js';
import { migration as searchFtsAndUsage } from './0005_search_fts_and_usage.js';
import { migration as memories } from './0006_memories.js';
import { migration as perfIndexesAndFtsFixes } from './0007_perf_indexes_and_fts_fixes.js';
import { migration as promptContextAudits } from './0008_prompt_context_audits.js';
import { migration as providerSecrets } from './0009_provider_secrets.js';
import { migration as connectionProfiles } from './0010_connection_profiles.js';
import { migration as characterFtsTags } from './0011_character_fts_tags.js';
import { migration as characterSortColumns } from './0012_character_sort_columns.js';
import { migration as chatSortOrder } from './0013_chat_sort_order.js';
import { migration as chatBackgrounds } from './0014_chat_backgrounds.js';
import { migration as pluginSource } from './0015_plugin_source.js';
import { migration as pluginStateAndGrants } from './0016_plugin_state_and_grants.js';
import { migration as pluginAuthConnections } from './0017_plugin_auth_connections.js';
import { migration as chatCasAndDrafts } from './0018_chat_cas_and_drafts.js';
import { migration as messageBlockAttachments } from './0019_message_block_attachments.js';
import { migration as swipeHistoryAndChildChats } from './0020_swipe_history_and_child_chats.js';
import { migration as messageContentRevisions } from './0021_message_content_revisions.js';

/** All migrations in ascending version order. */
export const migrations: readonly Migration[] = [
  init,
  contentAndImports,
  importArtifacts,
  repeatableImportJobs,
  pluginConsent,
  searchFtsAndUsage,
  memories,
  perfIndexesAndFtsFixes,
  promptContextAudits,
  providerSecrets,
  connectionProfiles,
  characterFtsTags,
  characterSortColumns,
  chatSortOrder,
  chatBackgrounds,
  pluginSource,
  pluginStateAndGrants,
  pluginAuthConnections,
  chatCasAndDrafts,
  messageBlockAttachments,
  swipeHistoryAndChildChats,
  messageContentRevisions,
];

export type { Migration } from './types.js';
