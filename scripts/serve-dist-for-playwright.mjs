import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const host = process.env.PLAYWRIGHT_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PLAYWRIGHT_PORT || process.argv[2] || '4173', 10);
const idleShutdownMs = Number.parseInt(process.env.PLAYWRIGHT_IDLE_SHUTDOWN_MS || '15000', 10);
let idleTimer;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

const resolveRequestPath = (urlPath) => {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  return path.resolve(distDir, relativePath);
};

const isInsideDist = (filePath) => filePath === distDir || filePath.startsWith(`${distDir}${path.sep}`);

const sendFile = async (res, filePath) => {
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    'Content-Length': data.byteLength,
    'Content-Type': mimeTypes.get(path.extname(filePath)) || 'application/octet-stream',
  });
  res.end(data);
};

const server = http.createServer(async (req, res) => {
  clearTimeout(idleTimer);
  try {
    const requestedPath = resolveRequestPath(req.url || '/');
    if (!isInsideDist(requestedPath)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      await sendFile(res, requestedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await sendFile(res, path.join(distDir, 'index.html'));
        return;
      }
      throw error;
    }
  } catch (error) {
    res.writeHead(500).end(error?.message || 'Server error');
  }
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

const scheduleIdleShutdown = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdown, idleShutdownMs);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.stdin.once('end', shutdown);
process.stdin.resume();

server.listen(port, host, () => {
  console.log(`Serving ${distDir} at http://${host}:${port}`);
  scheduleIdleShutdown();
});

server.on('request', (_req, res) => {
  res.once('finish', scheduleIdleShutdown);
});
