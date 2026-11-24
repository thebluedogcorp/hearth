'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HearthServer } = require('./server');

function parseArgs(argv) {
  const options = { dataDir: '', port: null, setupToken: '', ffmpegDir: '', cloudflared: '' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--data' || arg === '--data-dir') options.dataDir = argv[++index];
    else if (arg === '--setup-token') options.setupToken = argv[++index];
    else if (arg === '--ffmpeg-dir') options.ffmpegDir = argv[++index];
    else if (arg === '--cloudflared') options.cloudflared = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataDir || !path.isAbsolute(args.dataDir)) throw new Error('An absolute --data directory is required');
  if (!args.setupToken || args.setupToken.length < 32) {
    const bootstrapFile = path.join(args.dataDir, 'runtime', 'bootstrap.json');
    if (!fs.existsSync(bootstrapFile)) {
      throw new Error('A secure --setup-token of at least 32 characters is required before first-run setup');
    }
  }
  fs.mkdirSync(args.dataDir, { recursive: true, mode: 0o700 });
  const server = new HearthServer({ dataDir: args.dataDir, ffmpegDir: args.ffmpegDir, cloudflared: args.cloudflared, setupToken: args.setupToken });
  if (args.port && Number.isInteger(args.port)) server.store.setSetting('port', args.port);
  const address = await server.listen();
  process.stdout.write(`HEARTH_READY ${typeof address === 'object' ? `${address.address}:${address.port}` : String(address)}\n`);
  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    server.logger.info(`Shutting down (${signal})`);
    try { await server.close(); } catch (error) { server.logger.error('Shutdown error', { message: error.message }); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', error => {
    server.logger.error('Uncaught server exception', { message: error.message, stack: error.stack });
    if (!closing) shutdown('uncaughtException');
  });
  process.on('unhandledRejection', error => server.logger.error('Unhandled server rejection', { message: error.message, stack: error.stack }));
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ level: 'error', message: 'Hearth failed to start', detail: error.message })}\n`);
  process.exit(1);
});
