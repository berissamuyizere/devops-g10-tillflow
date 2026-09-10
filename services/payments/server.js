const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 8080);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'payments',
      msg: 'payments_started',
      port: PORT,
      mpesa_mode: process.env.MPESA_MODE || 'fake',
      commit: process.env.COMMIT_SHA || 'unknown',
    })
  );
});

const shutdown = (signal) => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'payments',
      msg: 'payments_shutting_down',
      signal,
    })
  );
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
