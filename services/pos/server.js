// TillFlow POS API.
//
// Tenant/sale model per docs/adr-001-tenant-sale-data-model.md.
// Payments status transitions only via /internal/v1/* (service token).

const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 8080);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'pos',
      msg: 'pos_started',
      port: PORT,
      commit: process.env.COMMIT_SHA || 'unknown',
    })
  );
});

const shutdown = (signal) => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
  console.log(JSON.stringify({ level: 'info', service: 'pos', msg: 'pos_shutting_down', signal }));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
