type ShutdownResources = {
  closeServer: () => Promise<void>;
  closeDatabase: () => void;
};

/** The unref'ed watchdog also covers handles left open after closeServer resolves. */
export function createShutdown(resources: ShutdownResources, timeoutMs = 2000) {
  let closing = false;
  let exitCode = 0;
  const closeDatabase = () => {
    try {
      resources.closeDatabase();
    } catch {
      console.error('[agentmind] DATABASE_CLOSE_ERROR');
      exitCode = 1;
    }
  };
  return async (requestedCode = 0): Promise<void> => {
    exitCode = Math.max(exitCode, requestedCode);
    process.exitCode = exitCode;
    if (closing) return;
    closing = true;
    const watchdog = setTimeout(() => {
      console.error('[agentmind] SHUTDOWN_TIMEOUT');
      closeDatabase();
      process.exit(1);
    }, timeoutMs);
    watchdog.unref();
    try {
      await resources.closeServer();
    } catch {
      console.error('[agentmind] SHUTDOWN_ERROR');
      exitCode = 1;
    } finally {
      closeDatabase();
      process.exitCode = exitCode;
    }
  };
}
