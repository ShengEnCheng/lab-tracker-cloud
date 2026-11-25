// 「先當 DEMO 用，之後把資料搬到正式系統」這條路會不會無縫？
//
// 使用者的情境：
//   1. 先用現在的線上系統當 DEMO 給老師與助理試
//   2. 試完覺得可以，助理用引導網頁建一套自己的
//   3. 把 DEMO 時期輸入的資料導出，再匯入新的那套
//   4. 希望接得上
//
// 這支測試走一遍真正的路：
//   匯出 → 匯入到空的新系統 → 確認資料一字不差
//
// 同時驗一件很容易被忽略的事：**成員名單（members）的角色**。
// 匯入的是「資料」，但「誰能登入」是 Auth 帳號，兩者不能混為一談。
// 如果匯入把成員名單覆蓋掉，新系統的管理員會看到自己不見了。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSupabase } from './mock-supabase.mjs';
import { validateLabData } from '../src/lib/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function startServer() {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const server = http.createServer(async (req, res) => {
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
    res.statusCode = 404;
    res.end('not found');
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

async function getJson(base, apiPath, headers = {}) {
  const response = await fetch(`${base}${apiPath}`, { headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// 模擬「DEMO 時期輸入的資料」：有兩個研究案、幾個個案、自訂研究案
// ---------------------------------------------------------------------------
function buildDemoData() {
  return {
    schemaVersion: 1,
    optBone: [
      { id: 'OPT-001', name: '王小明', study: 'OPT', status: '收案中', baselineDate: '2026-09-01', fup1Done: true },
      { id: 'OPT-002', name: '陳大華', study: 'OPT', status: '收案中', baselineDate: '2026-09-15', fup1Done: false }
    ],
    music40: [
      { id: 'MUS-001', name: '林小美', study: 'MUSIC40', status: '完成', baselineDate: '2026-08-20', fup1Done: true }
    ],
    members: [
      { id: 'PI', name: '鄭老師', role: 'PI' },
      { id: 'RA1', name: '助理一', role: '研究助理' }
    ],
    customStudies: [
      {
        code: 'SCREEN',
        name: '篩選研究',
        milestones: [{ key: 'screen1', label: '第一次篩選' }, { key: 'screen2', label: '第二次篩選' }],
        subjects: [
          { id: 'S-001', name: '張三', baselineDate: '2026-10-01', items: { screen1: { done: true, date: '2026-10-02' }, screen2: { done: false, date: '' } } }
        ]
      }
    ]
  };
}

console.log('\n【DEMO → 正式：資料導出匯入的無縫接軌】\n');

// === 第一部分：導出檔案的格式對不對 ===
console.log('1. 導出：DEMO 系統匯出的檔案長什麼樣');

const demoData = buildDemoData();

// 前端 downloadJsonBackup() 做的事：補上 schemaVersion 與 exportedAt
const exported = {
  ...JSON.parse(JSON.stringify(demoData)),
  schemaVersion: demoData.schemaVersion || 1,
  exportedAt: new Date().toISOString()
};

check('匯出檔案有 schemaVersion（新舊版本才分得出來）', exported.schemaVersion === 1);
check('匯出檔案有 exportedAt（知道什麼時候匯出的）', typeof exported.exportedAt === 'string');
check('匯出的內容可以用 schema 驗證通過',
  validateLabData(exported).length === 0, validateLabData(exported).join('；'));
check('匯出檔含兩個研究案的個案',
  exported.optBone.length === 2 && exported.music40.length === 1);
check('匯出檔含自訂研究案與它的里程碑', exported.customStudies[0].milestones.length === 2);

// === 第二部分：匯入到「全新的正式系統」 ===
console.log('\n2. 匯入：全新系統接收 DEMO 的資料');

const server = await startServer();
const ADMIN = {
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  adminName: '新管理員',
  adminEmail: 'new-admin@example.edu.tw',
  adminPassword: '{{SECRET_2cgnx2v4}}',
  withSampleData: false
};
const setup = await postJson(server.url, '/api/setup', ADMIN);
check('新系統完成第一次設定', setup.status === 200, `HTTP ${setup.status}`);
check('新系統是空白的（沒有示範資料）',
  (server.mock.state.tables.lab_state[0]?.data?.optBone || []).length === 0);

const login = await postJson(server.mock.url, '/auth/v1/token?grant_type=password', {
  email: ADMIN.adminEmail,
  password: ADMIN.adminPassword
});
check('新管理員登得進去', login.status === 200);
const AUTH = { authorization: `Bearer ${login.body.access_token}` };

// 前端匯入時做的事：POST /api/import，帶 requestId 與檔案內容
const importResult = await postJson(server.url, '/api/import', {
  requestId: crypto.randomUUID(),
  data: exported
}, AUTH);

check('匯入成功', importResult.status === 200, `HTTP ${importResult.status} ${JSON.stringify(importResult.body).slice(0, 150)}`);

// === 第三部分：資料有沒有真的進去、有沒有走樣 ===
console.log('\n3. 驗證：接得上嗎');

const afterImport = await getJson(server.url, '/api/data', AUTH);
check('匯入後讀得到資料', afterImport.status === 200);

const stored = afterImport.body.data || {};
check('OPT 個案全部都在（2 筆）', (stored.optBone || []).length === 2, `實際 ${(stored.optBone || []).length} 筆`);
check('music40 個案也在（1 筆）', (stored.music40 || []).length === 1);
check('自訂研究案還在', (stored.customStudies || []).length === 1);
check('自訂研究案的里程碑完整', (stored.customStudies?.[0]?.milestones || []).length === 2);

// 逐筆比對內容，不只是數量
const opt001 = (stored.optBone || []).find(item => item.id === 'OPT-001');
check('個案內容一字不差（編號、姓名、狀態、日期）',
  opt001?.name === '王小明'
  && opt001?.status === '收案中'
  && opt001?.baselineDate === '2026-09-01'
  && opt001?.fup1Done === true,
  JSON.stringify(opt001));

const screen = stored.customStudies?.[0];
check('自訂研究案裡的里程碑打勾狀態保留',
  screen?.subjects?.[0]?.items?.screen1?.done === true
  && screen?.subjects?.[0]?.items?.screen2?.done === false);

// === 第四部分：最容易被忽略的那件事 —— 成員名單 ===
console.log('\n4. 成員名單：匯入不能把新系統的管理員弄丟');

// 匯入的資料裡有 DEMO 時期的成員（PI / RA1），但那是「資料」。
// 新系統真正的登入帳號是 Auth 帳號 + lab_profiles，不受匯入影響。
const profiles = server.mock.state.tables.lab_profiles || [];
check('新系統的管理員 profile 還在（沒有被匯入覆蓋）', profiles.length >= 1);
check('管理員還是原本那位，沒有變成 DEMO 的成員',
  profiles.some(item => item.role === 'admin' && item.email === ADMIN.adminEmail),
  profiles.map(item => `${item.email}/${item.role}`).join(', '));
check('匯入沒有偷偷建立新的登入帳號',
  server.mock.state.authUsers.length === 1,
  `authUsers=${server.mock.state.authUsers.length}`);

// === 第五部分：匯入不能繞過權限 ===
console.log('\n5. 匯入的權限邊界');

const noAuth = await postJson(server.url, '/api/import', {
  requestId: crypto.randomUUID(),
  data: buildDemoData()
});
check('未登入不能匯入', [401, 403].includes(noAuth.status), `HTTP ${noAuth.status}`);

const badData = await postJson(server.url, '/api/import', {
  requestId: crypto.randomUUID(),
  data: { optBone: 'not-an-array' }
}, AUTH);
check('格式壞掉的檔案會被擋下（422）', badData.status === 422, `HTTP ${badData.status}`);
check('壞檔案沒有把現有資料弄壞', (await getJson(server.url, '/api/data', AUTH)).body.data?.optBone?.length === 2);

// === 第六部分：二次匯入（同一份檔案再匯一次）===
console.log('\n6. 重複匯入同一份檔案');

const second = await postJson(server.url, '/api/import', {
  requestId: crypto.randomUUID(),
  data: exported
}, AUTH);
check('同一份檔案可以再匯一次（不會卡住）', second.status === 200, `HTTP ${second.status}`);

const afterSecond = await getJson(server.url, '/api/data', AUTH);
check('重複匯入不會讓資料變成兩份', (afterSecond.body.data?.optBone || []).length === 2,
  `實際 ${(afterSecond.body.data?.optBone || []).length} 筆`);

await server.close();

console.log(`\nDEMO 接軌正式系統：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
