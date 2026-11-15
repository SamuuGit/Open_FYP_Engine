import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecommendationEngine, DEFAULT_VIDEO_CATALOG } from './RecommendationEngine.js';
import { decompressPayloadGzip } from '../core/FeedApiClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const engine = new RecommendationEngine(DEFAULT_VIDEO_CATALOG);
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // Configuração básica de CORS e Headers JSON
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Encoding');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Endpoint do Feed "Para Você" (POST ou GET)
  if (url.pathname === '/api/recommend/item_list/' || url.pathname === '/api/prefetch/recommend/item_list/') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const rawBuffer = Buffer.concat(chunks);
        let bodyObject = null;

        if (rawBuffer.length > 0) {
          const contentEncoding = req.headers['content-encoding'];
          if (contentEncoding === 'gzip') {
            bodyObject = await decompressPayloadGzip(rawBuffer);
          } else {
            bodyObject = JSON.parse(rawBuffer.toString('utf-8'));
          }
        }

        const queryParams = Object.fromEntries(url.searchParams.entries());
        const responseData = await engine.handleRecommendRequest({
          endpoint: url.pathname,
          queryParams,
          rawBodyObject: bodyObject,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint analítico de eventos (Canal 2: POST /v1/list)
  if (url.pathname === '/v1/list') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const eventCount = body?.[0]?.events?.length || 0;
        console.log(`[Servidor /v1/list] Lote recebido com ${eventCount} eventos analíticos.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 0, statusMsg: 'success', recordedEvents: eventCount }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 0 }));
      }
    });
    return;
  }

  // Endpoints de Ações de Engajamento
  if (url.pathname.startsWith('/api/commit/') || url.pathname.startsWith('/api/dislike/') || url.pathname.startsWith('/api/item/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ statusCode: 0, statusMsg: 'action_recorded' }));
    return;
  }

  // Servir arquivos estáticos do diretório public
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`🚀 Open FYP Server rodando em: http://localhost:${PORT}`);
  console.log(`=============================================================\n`);
});
