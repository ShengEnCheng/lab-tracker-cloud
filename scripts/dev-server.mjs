// 本機開發伺服器：模擬 Vercel 的執行環境，讓維護者不必部署就能測。
//
// 三個模擬重點：
//   1. /api/* 依檔名動態載入 api/<name>.js，與 Vercel 的檔案路由一致
//   2. 提供 Express 風格的 res.status()，因為 Vercel 的 handler 這樣寫
//   3. 讀 .env.local（與 Vercel 的環境變數同名），讓本機與線上行為一致
//
// 刻意不引入任何 npm 套件：這個專案要能被研究室直接拿去用，
// 多一個依賴就多一個「npm install 失敗」的支援問題。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    // 去掉成對的引號
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 既有的 process.env 優先（讓命令列可以覆蓋檔案設定）
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// .env.local 優先，其次 .env
loadEnvFile(path.join(ROOT_DIR, '.env.local')) || loadEnvFile(path.join(ROOT_DIR, '.env'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// Vercel 會把 query string 解析掉，本機也要，否則 handler 拿到的 req.url 不一致
function splitUrl(rawUrl) {
  const url = new URL(rawUrl, 'http://localhost');
  return { pathname: decodeURIComponent(url.pathname), query: url.searchParams };
}

const server = http.createServer(async (req, res) => {
  // Vercel handler 用 res.status(...)，本機用 Node 原生，這裡補上
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };

  const { pathname, query } = splitUrl(req.url);
  req.query = Object.fromEntries(query.entries());

  if (pathname.startsWith('/api/')) {
    const apiName = pathname.slice('/api/'.length).replace(/\/$/, '');
    const apiFile = path.join(ROOT_DIR, 'api', `${apiName}.js`);
    if (fs.existsSync(apiFile)) {
      try {
        // 加時間戳避免快取，讓修改後不用重啟
        const mod = await import(`${apiFile}?t=${Date.now()}`);
        if (typeof mod.default === 'function') return await mod.default(req, res);
      } catch (err) {
        console.error(`[API ERROR] ${req.method} ${pathname}:`, err);
        res.status(500).setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
      }
    }
    res.status(404).setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'not_found', path: pathname }));
  }

  // 靜態檔；找不到就回 index.html，讓前端路由自己處理
  let filePath = pathname === '/' ? path.join(ROOT_DIR, 'index.html') : path.join(ROOT_DIR, pathname);
  if (!filePath.startsWith(ROOT_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('content-type', contentType);
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const PORT = Number(process.env.PORT) || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const configured = Boolean(process.env.SUPABASE_URL);
  console.log(`研究室追蹤系統 本機伺服器：http://localhost:${PORT}`);
  console.log(configured
    ? '資料庫：已載入 SUPABASE_URL'
    : '資料庫：尚未設定（複製 .env.example 為 .env.local 並填入 Supabase 設定）');
});
