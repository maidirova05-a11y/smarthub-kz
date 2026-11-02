/**
 * Сервер Docker-версии SmartHub: делает то же, что Vercel делает для этого
 * проекта, — отдаёт статику с чистыми адресами (cleanUrls, без слеша в конце),
 * вызывает функции из api/ и ставит заголовки из vercel.json.
 *
 * Отдаются только файлы из public/ (в образе туда скопирован сам сайт), так что
 * код api/, lib/ и прочее по URL недоступны.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const BODY_LIMIT = 1024 * 1024;

const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));

// "/api/(.*)" → /^\/api\/(.*)$/ — других конструкций в vercel.json нет.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerRules = (vercel.headers || []).map((rule) => ({
  re: new RegExp(`^${rule.source.split('(.*)').map(escape).join('(.*)')}$`),
  headers: rule.headers,
}));

const API = {};
for (const name of ['health', 'lead', 'leads', 'login']) {
  API[name] = (await import(join(ROOT, 'api', `${name}.js`))).default;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function fileAt(path) {
  const full = resolve(PUBLIC, `.${path}`);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + sep)) return null;
  try {
    return (await stat(full)).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Как Vercel с cleanUrls: /privacy → privacy.html, /en → en/index.html. */
async function resolveStatic(pathname) {
  if (pathname === '/') return fileAt('/index.html');
  return (await fileAt(pathname)) || (await fileAt(`${pathname}.html`)) || fileAt(`${pathname}/index.html`);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        fail(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/** req.body, req.query и res.status().json() — как у функций Vercel. */
async function callApi(fn, req, res, url) {
  const raw = await readBody(req);
  const type = String(req.headers['content-type'] || '');
  let body = raw.length ? raw.toString('utf8') : undefined;
  if (body !== undefined && type.includes('application/json')) {
    try { body = JSON.parse(body); } catch { /* оставляем строкой — обработчики это умеют */ }
  } else if (body !== undefined && type.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(body));
  }
  req.body = body;
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (data) => {
    if (data !== null && typeof data === 'object' && !Buffer.isBuffer(data)) return res.json(data);
    res.end(data);
    return res;
  };
  await fn(req, res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    // trailingSlash: false и cleanUrls: адрес со слешем или .html — на чистый.
    const clean = pathname.length > 1 && pathname.endsWith('/') ? pathname.replace(/\/+$/, '')
      : pathname.endsWith('/index.html') ? pathname.slice(0, -'/index.html'.length) || '/'
      : pathname.endsWith('.html') ? pathname.slice(0, -'.html'.length)
      : null;
    if (clean !== null && !pathname.startsWith('/api/')) {
      res.writeHead(308, { Location: clean + url.search }).end();
      return;
    }

    for (const rule of headerRules) {
      if (rule.re.test(pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
    }

    const api = pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const fn = API[api[1]];
      if (!fn) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false,"error":"not_found"}');
        return;
      }
      await callApi(fn, req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const file = await resolveStatic(pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const data = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Content-Length', data.length);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    console.error('serve:', err);
    if (!res.headersSent) res.writeHead(err.status || 500).end(err.status === 413 ? 'Payload too large' : 'Server error');
    else res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log(`smarthub on :${PORT}`));
