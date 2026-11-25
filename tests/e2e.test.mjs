// 端到端測試：把「助理在瀏覽器裡完成第一次設定」的整條路走一遍。
//
// 為什麼不用真的瀏覽器
// --------------------
// tests/ui.test.mjs 已經用真 Chrome 驗證過「畫面」正確（用假的 fetch）。
// 這支要驗證的是另一半：**請求真的送出、資料真的落地、回應真的正確**。
// 兩支合起來才等於「瀏覽器 + 伺服器」的完整路徑。
//
// 這裡的每個請求都完全照抄 index.html 實際會發出的形狀
// （方法、路徑、標頭、body 欄位名），所以 API 契約改了這支就會紅。
//
// 註：本機的 headless Chrome 在此環境中無法連上任何 HTTP 伺服器
// （file:// 可以，http:// 一律連不上，連請求都不會到達伺服器），
// 所以無法用瀏覽器打真伺服器。這是環境限制，不是程式問題。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSupabase } from './mock-supabase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
let total = 0;

function check(name, ok, detail = '') {
  total += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

// ---------------------------------------------------------------------------
// 起一個與研究室線上環境相同的伺服器（同樣的 api/ handler、同樣的路由）
// ---------------------------------------------------------------------------
async function startServer() {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);

  const server = http.createServer(async (req, res) => {
    // Vercel 的 handler 用 res.status()，這裡補上（與 dev-server.mjs 一致）
    res.status = function status(code) { this.statusCode = code; return this; };
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams.entries());
    const { pathname } = url;

    if (pathname.startsWith('/api/')) {
      const name = pathname.slice('/api/'.length).replace(/\/$/, '');
      const file = path.join(ROOT, 'api', `${name}.js`);
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'not_found' }));
      }
      try {
        const mod = await import(`${file}?t=${Date.now()}`);
        return await mod.default(req, res);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'internal_error', message: error.message }));
      }
    }

    let filePath = pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, pathname);
    if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end('Forbidden'); }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(ROOT, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.statusCode = 200;
    res.setHeader('content-type', types[ext] || 'application/octet-stream');
    res.end(fs.readFileSync(filePath));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    mock,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await mock.close();
    }
  };
}

// 完全照 index.html 的形狀打請求
async function getJson(base, apiPath, headers = {}) {
  const response = await fetch(`${base}${apiPath}`, { headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function postJson(base, apiPath, payload, headers = {}) {
  const response = await fetch(`${base}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
const server = await startServer();
console.log(`\n【端到端：全新部署 → 完成設定】`);
console.log(`   伺服器：${server.url}\n`);

// === 階段 1：使用者的瀏覽器第一次打開網址 ===
console.log('階段 1：第一次打開網址');

const pageResponse = await fetch(`${server.url}/`);
const pageHtml = await pageResponse.text();
check('首頁載入成功', pageResponse.status === 200);
check('頁面含第一次設定畫面', pageHtml.includes('id="setupGate"'));
check('頁面沒有寫死任何 Supabase 網址', !/[a-z0-9]{20}\.supabase\.co/.test(pageHtml));
check('頁面沒有作者的名字', !pageHtml.includes('鄭'));

// index.html 的 DOMContentLoaded 會先打 /api/config
const config1 = await getJson(server.url, '/api/config');
check('GET /api/config 成功', config1.status === 200);
check('回報後端已設定（模擬資料庫已接上）', config1.body.backendConfigured === true);
check('回報尚未完成設定（所以顯示設定畫面）', config1.body.setupComplete === false);
check('/api/config 不含 secret 金鑰', !JSON.stringify(config1.body).toLowerCase().includes('secret_key'));
check('/api/config 提供前端金鑰', typeof config1.body.anonKey === 'string' && config1.body.anonKey.length > 0);

// === 階段 2：使用者填完表單，按「建立我的研究室」 ===
console.log('\n階段 2：填完表單送出');

// 先確認錯誤處理：填錯資料要看到逐欄錯誤，而不是一句「失敗」
const badSubmit = await postJson(server.url, '/api/setup', {
  organizationName: '',
  adminName: '',
  adminEmail: 'not-an-email',
  adminPassword: 'abc',
  withSampleData: true
});
check('資料錯誤回 422 而不是 500', badSubmit.status === 422, `得到 ${badSubmit.status}`);
check('錯誤訊息逐欄列出（使用者才知道改哪一格）',
  Boolean(badSubmit.body.errors?.adminEmail && badSubmit.body.errors?.adminPassword && badSubmit.body.errors?.organizationName));

const SETUP = {
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  adminName: '王小明',
  adminEmail: 'pi@example.edu.tw',
  adminPassword: '{{SECRET_2cgnx2v4}}',
  withSampleData: true
};
const submit = await postJson(server.url, '/api/setup', SETUP);

check('送出設定成功（HTTP 200）', submit.status === 200, `得到 ${submit.status}`);
check('回應帶研究室名稱', submit.body.organization?.name === '認知神經科學研究室');
check('回應帶清理後的代碼（大寫）', submit.body.organization?.code === 'CNC');
check('回應帶初始資料版本號', submit.body.revision === 1);

// === 階段 3：資料真的落地 ===
console.log('\n階段 3：資料真的寫進資料庫');

check('建立了登入帳號', server.mock.state.authUsers.length === 1);
check('帳號 email 正確', server.mock.state.authUsers[0]?.email === 'pi@example.edu.tw');
check('密碼是使用者填的那個（沒有被換成固定預設值）',
  server.mock.state.authUsers[0]?.password === SETUP.adminPassword);
check('帳號已驗證（不用再收信確認）', server.mock.state.authUsers[0]?.email_confirm === true);

const profile = server.mock.state.tables.lab_profiles[0];
check('建立了管理員成員資料', Boolean(profile));
check('成員角色是 admin', profile?.role === 'admin');
check('成員是啟用狀態', profile?.active === true);
check('成員名稱正確', profile?.display_name === '王小明');

const settings = server.mock.state.tables.lab_settings[0];
check('寫入了研究室名稱', settings?.organization_name === '認知神經科學研究室');
check('寫入了設定完成時間（這就是鎖）', Boolean(settings?.setup_completed_at));

const stateRow = server.mock.state.tables.lab_state[0];
check('寫入了初始資料', Boolean(stateRow));
check('初始資料版本是 1', stateRow?.revision === 1);
check('示範資料的成員編號都是 DEMO 開頭',
  (stateRow?.data?.members || []).every(m => /^DEMO/.test(m.code)),
  (stateRow?.data?.members || []).map(m => m.code).join(','));

// === 階段 4：畫面切換到「設定完成」 ===
console.log('\n階段 4：重新載入後不再顯示設定畫面');

const config2 = await getJson(server.url, '/api/config');
check('現在回報 setupComplete=true', config2.body.setupComplete === true);
check('回報研究室名稱（頁首會顯示它）', config2.body.organizationName === '認知神經科學研究室');

const status2 = await getJson(server.url, '/api/setup-status');
check('setup-status 回報已完成設定', status2.body.setupComplete === true);
check('setup-status 回報有管理員', status2.body.adminExists === true);
check('setup-status 所有檢查都通過',
  status2.body.checks?.environment?.ok && status2.body.checks?.database?.ok && status2.body.checks?.schema?.ok);
check('setup-status 不回傳任何金鑰或 Email',
  !JSON.stringify(status2.body).includes('sb_secret') && !JSON.stringify(status2.body).includes('pi@example.edu.tw'));

// === 階段 5：安全邊界 ===
console.log('\n階段 5：安全邊界');

const takeover = await postJson(server.url, '/api/setup', {
  ...SETUP,
  adminEmail: 'attacker@evil.com',
  adminName: '壞人',
  organizationName: '被佔走了'
});
check('別人不能再設定一次（409）', takeover.status === 409, `得到 ${takeover.status}`);
check('錯誤碼是 already_setup', takeover.body.error === 'already_setup');
check('攻擊者沒有被建立', server.mock.state.authUsers.length === 1);
check('研究室名稱沒有被改掉', server.mock.state.tables.lab_settings[0]?.organization_name === '認知神經科學研究室');
check('管理員沒有被換掉', server.mock.state.tables.lab_profiles[0]?.email === 'pi@example.edu.tw');

// === 階段 6：健康檢查端點（引導網頁靠它判斷部署成功） ===
console.log('\n階段 6：健康檢查');

const health = await getJson(server.url, '/api/health');
check('GET /api/health 回 200', health.status === 200);
check('回報 app 名稱（wizard 用它確認打對系統）', health.body.app === 'lab-tracker-cloud');
check('回報版號', /^\d+\.\d+\.\d+$/.test(health.body.version || ''));
check('回報後端已設定', health.body.backendConfigured === true);
check('健康檢查不含任何金鑰', !JSON.stringify(health.body).toLowerCase().includes('sb_secret'));

// === 階段 7：設定完成後，未登入的人不能讀資料 ===
console.log('\n階段 7：未登入的使用者不能讀寫資料');

const dataWithoutAuth = await getJson(server.url, '/api/data');
check('未登入讀資料被拒（401 或 403）',
  [401, 403].includes(dataWithoutAuth.status), `得到 ${dataWithoutAuth.status}`);

const dataWithBadToken = await getJson(server.url, '/api/data', { authorization: 'Bearer fake-token' });
check('帶假 token 也被拒', [401, 403].includes(dataWithBadToken.status), `得到 ${dataWithBadToken.status}`);

// === 階段 8：引導網頁需要的跨網域存取 ===
//
// 引導網頁跑在別的網域（可能是 file://，也可能是維護者的網站），
// 它要能讀 health / setup-status / config 才知道「你的部署成功了」。
// 這三個端點沒有 CORS 標頭的話，瀏覽器會擋住回應 ——
// 使用者會看到「看不出來」，明明部署好了卻被告知不確定。
console.log('\n階段 8：引導網頁的跨網域存取');

const wizardOrigin = 'http://127.0.0.1:9999';
for (const apiPath of ['/api/health', '/api/setup-status', '/api/config']) {
  const res = await fetch(`${server.url}${apiPath}`, { headers: { origin: wizardOrigin } });
  check(`${apiPath} 允許跨網域讀取`, res.headers.get('access-control-allow-origin') === '*',
    res.headers.get('access-control-allow-origin') || '(沒有標頭)');
}

// 預檢請求（帶自訂標頭時瀏覽器會先送這個）
const preflight = await fetch(`${server.url}/api/setup-status`, {
  method: 'OPTIONS',
  headers: { origin: wizardOrigin, 'access-control-request-method': 'GET' }
});
check('預檢請求回 204', preflight.status === 204, `得到 ${preflight.status}`);

// 需要身分的端點不可以開放跨網域：那等於讓任何網頁代打使用者的帳號
for (const apiPath of ['/api/data', '/api/profiles', '/api/backups']) {
  const res = await fetch(`${server.url}${apiPath}`, {
    headers: { origin: wizardOrigin, authorization: 'Bearer fake' }
  });
  check(`${apiPath} 不開放跨網域`, !res.headers.get('access-control-allow-origin'),
    res.headers.get('access-control-allow-origin') ? '竟然開放了' : '');
}

await server.close();

console.log(`\n端到端測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
