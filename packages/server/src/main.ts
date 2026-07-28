import { buildApp } from './app.js';

async function main(): Promise<void> {
  const app = await buildApp();
  const { server, env } = app;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down gracefully');
    const timer = setTimeout(() => {
      server.log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    timer.unref();
    try {
      await app.close();
      clearTimeout(timer);
      server.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    server.log.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    server.log.error({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  try {
    await server.listen({ host: env.HOST, port: env.PORT });
    server.log.info({ host: env.HOST, port: env.PORT, dataDir: env.dataDir }, 'SOOYA is listening');
  } catch (err) {
    server.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
