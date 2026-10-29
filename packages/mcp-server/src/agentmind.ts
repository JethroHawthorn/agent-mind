#!/usr/bin/env node
// Keep dependency loading inside a boundary so missing runtime packages fail safely before setup.
try {
  await import('./agentmind-main.js');
} catch (error) {
  const e = error as { code?: string; message?: string };
  const missing = /MODULE_NOT_FOUND/.test(e.code ?? '');
  const code = missing
    ? /better-sqlite3/.test(e.message ?? '')
      ? 'SQLITE_DRIVER_MISSING'
      : 'INSTALLER_DEPENDENCY_MISSING'
    : 'INSTALLER_INTERNAL';
  const result = {
    schema_version: 1,
    error: {
      code,
      message:
        'AgentMind runtime could not load. Reinstall dependencies for the current Node runtime; no setup changes were performed.',
    },
  };
  (process.argv.includes('--json') ? process.stdout : process.stderr).write(
    `${JSON.stringify(result)}\n`,
  );
  process.exitCode = missing ? 5 : 1;
}
