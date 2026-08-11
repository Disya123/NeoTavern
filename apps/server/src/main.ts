/**
 * Server entry point. Opens (and auto-migrates) the SQLite database, wires the
 * provider registry, builds the Fastify app and listens on loopback by default.
 */
import { createWriteStream, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAppDatabase } from '@neotavern/db';
import { ProviderRegistry } from '@neotavern/provider-sdk';
import { createLogger, type LogLevel } from '@neotavern/shared';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { ensureDataDirs, resolveDataPaths } from './lib/paths.js';
import { seedStarterContent } from './lib/starterContent.js';
import { seedBundledThemes } from './lib/bundledThemes.js';
import { ContextStrategyRegistry } from './pipeline/contextShift.js';
import { PostProcessorRegistry } from './pipeline/postProcess.js';

/** Rotate server.log at startup once it grows past this size (ТЗ §10.3). */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

async function main(): Promise<void> {
  const config = loadConfig();

  const paths = resolveDataPaths(config.dataDir);
  ensureDataDirs(paths);

  // Structured redacted log file (the data/logs directory is part of the ТЗ
  // layout); console output is preserved alongside the file sink.
  const logPath = join(paths.logs, 'server.log');
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    // No previous log — nothing to rotate.
  }
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const logger = createLogger({
    scope: 'server',
    level: config.logLevel as LogLevel,
    sink: (line) => {
      console.log(line);
      logStream.write(`${line}\n`);
    },
  });

  const database = createAppDatabase(paths.dbFile, { autoBackupDir: paths.backups });
  await seedStarterContent({ database, paths, logger });
  await seedBundledThemes({ database, paths, logger });

  // Rev4 stage 3: sweep stale streaming drafts at startup and hourly. A
  // crashed writer leaves an uncommitted draft row (never a half-written
  // committed message); committed drafts keep a row only long enough for
  // commit retries to stay idempotent.
  const DRAFT_COMMITTED_TTL_MS = 60 * 60 * 1000;
  const DRAFT_UNCOMMITTED_TTL_MS = 24 * 60 * 60 * 1000;
  const DRAFT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const sweepDrafts = (): void => {
    database.repos.messageDrafts
      .sweep(Date.now(), DRAFT_COMMITTED_TTL_MS, DRAFT_UNCOMMITTED_TTL_MS)
      .then((removed) => {
        if (removed > 0) logger.info(`draft sweep removed ${removed} stale row(s)`);
      })
      .catch((error: unknown) => {
        logger.error(
          `draft sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  sweepDrafts();
  const draftSweepTimer = setInterval(sweepDrafts, DRAFT_SWEEP_INTERVAL_MS);
  draftSweepTimer.unref?.();

  const providers = new ProviderRegistry();
  const contextStrategies = new ContextStrategyRegistry();
  const postProcessors = new PostProcessorRegistry();

  const app = await buildApp({
    database,
    providers,
    contextStrategies,
    postProcessors,
    config,
    logger,
    paths,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      // A second fatal signal while already shutting down: don't hang.
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down gracefully`);
    clearInterval(draftSweepTimer);
    let code = exitCode;
    try {
      await app.close();
      database.close();
    } catch (error) {
      // Close failures must be visible and reflected in the exit code —
      // exiting 0 would mask an unclean shutdown.
      logger.error(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Process-level safety net. Node 24 terminates on unhandled rejections by
  // default; as a local-first app we log and survive stray rejections, and
  // only take a controlled shutdown (non-zero exit) on a true uncaught
  // exception, where process state is undefined.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${error.stack ?? error.message}`);
    void shutdown('uncaughtException', 1);
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info(`NeoTavern API listening on http://${config.host}:${config.port}`);
}

main().catch((error: unknown) => {
  console.error('[server] fatal startup error', error);
  process.exit(1);
});
