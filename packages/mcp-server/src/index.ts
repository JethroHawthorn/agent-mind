#!/usr/bin/env node
import {
  ExperienceService,
  LearningReviewService,
  LearningSignalService,
  MemoryService,
  migrateRetrieval,
  openDatabase,
  RecommendationService,
  SkillAuthoringService,
  SkillProposalService,
  SkillRetrievalService,
  SkillReviewService,
  SkillStore,
  SkillUsageService,
  safeError,
} from '@agentmind/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createServer } from './server.js';
import { createShutdown } from './shutdown.js';

async function main(): Promise<void> {
  // Restrict new SQLite/WAL/SHM files on POSIX; no permissions are widened.
  process.umask(0o077);
  const config = readConfig();
  const db = openDatabase(config.dbPath);
  try {
    const memory = new MemoryService(db, config.project, config.sourceAgent);
    if (config.health) {
      console.error(JSON.stringify(memory.health()));
      db.close();
      return;
    }
    const experiences = new ExperienceService(
      db,
      config.project,
      config.sourceAgent,
      config.captureEnabled,
    );
    if (config.retrievalEnabled) migrateRetrieval(db);
    const server = createServer(
      memory,
      experiences,
      config.captureEnabled,
      {
        store: new SkillStore(db, config.project),
        proposals: new SkillProposalService(
          db,
          config.project,
          config.sourceAgent,
          config.proposalEnabled,
        ),
        proposalEnabled: config.proposalEnabled,
        review: new SkillReviewService(db, config.project),
        usage: new SkillUsageService(
          db,
          config.project,
          config.sourceAgent,
          config.telemetryEnabled,
        ),
      },
      config.curatorEnabled ? new RecommendationService(db, config.project) : undefined,
      config.learningEnabled
        ? new LearningSignalService(
            db,
            config.project,
            config.sourceAgent,
            'explicit-mcp-v1',
            config.learningCaptureEnabled,
          )
        : undefined,
      config.authoringEnabled
        ? new SkillAuthoringService(db, config.project, config.sourceAgent, config.proposalEnabled)
        : undefined,
      config.authoringEnabled ? new LearningReviewService(db, config.project) : undefined,
      config.retrievalEnabled ? new SkillRetrievalService(db, config.project) : undefined,
    );
    const shutdown = createShutdown({
      closeServer: () => server.close(),
      closeDatabase: () => {
        if (db.open) db.close();
      },
    });
    server.server.onclose = () => {
      void shutdown();
    };
    server.server.onerror = () => console.error('[agentmind] PROTOCOL_ERROR');
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.stdin.once('end', () => {
      void shutdown();
    });
    process.once('uncaughtException', () => {
      console.error('[agentmind] UNCAUGHT_ERROR');
      void shutdown(1);
    });
    process.once('unhandledRejection', () => {
      console.error('[agentmind] UNHANDLED_REJECTION');
      void shutdown(1);
    });
    await server.connect(new StdioServerTransport());
    console.error('[agentmind] ready (stdio, project scoped)');
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  const failure = safeError(error);
  console.error(`[agentmind] ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});
