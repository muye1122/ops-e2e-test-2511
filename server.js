/**
 * Local production-like launcher: starts the operations API and serves the
 * built demo on another port with /api proxied. The gateway, review queue and
 * mock vendor are started separately with `npm run services`.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.OPS_PORT = process.env.OPS_PORT || '3001';
await import('./mock-server/ops.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const opts = {
      hostname: '127.0.0.1', port: Number(process.env.OPS_PORT), path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${process.env.OPS_PORT}` },
    };
    const p = http.request(opts, (r) => { res.writeHead(r.statusCode || 200, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(p);
    return;
  }
  let file = path.join(__dirname, 'dist', decodeURIComponent(url.pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(__dirname, 'dist', 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not built; run npm run build'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const PORT = Number(process.env.UI_PORT || 4173);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ops-assistant] demo http://0.0.0.0:${PORT}  [api] http://0.0.0.0:${process.env.OPS_PORT}`);
});
