// 「設定完成之後，研究室成員真的能登入、看到資料、存得了東西嗎？」
//
// 前面幾支測試驗的是「部署與設定」這段路（引導網頁 → 第一次設定 → 資料落地）。
// 這支驗的是設定完成之後的日常使用：
//
//   1. 用剛剛設定的帳密登入（前端是直接跟 Supabase Auth 要 JWT）
//   2. 拿到 token 之後讀共用資料
//   3. 修改後存回去
//   4. 兩個人同時改 → 後改的人被擋下（不是靜默覆蓋）
//   5. 沒登入的人什麼都看不到
//
// 這是整個產品最後一段沒被驗證過的路。如果這段壞了，研究室會覺得
// 「安裝看起來成功，可是進去什麼都沒有 / 存不進去」。

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
const server = await startServer();
console.log('\n【設定完成後的日常使用：登入 → 讀 → 寫】\n');

const ADMIN = {
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  adminName: '王小明',
  adminEmail: 'pi@example.edu.tw',
  adminPassword: '{{SECRET_2cgnx2v4}}',
  withSampleData: false
};

// === 先完成第一次設定（前置條件）===
const setup = await postJson(server.url, '/api/setup', ADMIN);
console.log(`（前置：完成第一次設定 → HTTP ${setup.status}）\n`);
if (setup.status !== 200) {
  console.error('✗ 前置設定失敗，後面的測試沒有意義。');
  process.exit(1);
}

// === 1. 登入 ===
console.log('1. 用剛剛設定的帳密登入');

// 前端登入是直接打 Supabase Auth（不經過我們的 API）
const login = await postJson(server.mock.url, '/auth/v1/token?grant_type=password', {
  email: ADMIN.adminEmail,
  password: ADMIN.adminPassword
});
check('正確的帳密可以登入', login.status === 200, `HTTP ${login.status}`);
check('登入後拿到 access_token', typeof login.body.access_token === 'string' && login.body.access_token.length > 0);
check('登入後拿到使用者 id', Boolean(login.body.user?.id));

const TOKEN = login.body.access_token;
const AUTH = { authorization: `Bearer ${TOKEN}` };

const wrongLogin = await postJson(server.mock.url, '/auth/v1/token?grant_type=password', {
  email: ADMIN.adminEmail,
  password: 'wrong-password-123'
});
check('錯的密碼登不進去', wrongLogin.status >= 400, `HTTP ${wrongLogin.status}`);

// === 2. 讀共用資料 ===
console.log('\n2. 登入後讀共用資料');

const read1 = await getJson(server.url, '/api/data', AUTH);
check('登入後讀得到資料', read1.status === 200, `HTTP ${read1.status}`);
check('回應帶資料內容', Boolean(read1.body.data));
check('回應帶版本號（樂觀鎖要用）', Number.isInteger(read1.body.revision));
check('資料結構完整（有個案與成員）',
  Array.isArray(read1.body.data?.optBone) && Array.isArray(read1.body.data?.members));

const revision1 = Number(read1.body.revision);
check('剛設定完的版本是 1', revision1 === 1, `revision=${revision1}`);

// === 3. 寫入 ===
console.log('\n3. 修改後存回去');

const newCase = {
  id: 'S001',
  name: '受試者一號',
  study: 'OPT',
  status: '進行中'
};
const write1 = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: revision1,
  data: { ...read1.body.data, optBone: [...read1.body.data.optBone, newCase] }
}, AUTH);

check('存得回去', write1.status === 200, `HTTP ${write1.status} ${JSON.stringify(write1.body).slice(0, 120)}`);
check('版本號往前進', Number(write1.body.revision) === revision1 + 1, `revision=${write1.body.revision}`);

const read2 = await getJson(server.url, '/api/data', AUTH);
check('重新讀得到剛存的資料',
  (read2.body.data?.optBone || []).some(item => item.id === 'S001'));
check('版本號確實變成 2', Number(read2.body.revision) === 2);

// === 4. 樂觀鎖：兩人同時改 ===
console.log('\n4. 兩個人同時改同一份資料');

// 兩個人都拿到 revision=2，各自改各自的
const baseForBoth = Number(read2.body.revision);

const first = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: baseForBoth,
  data: { ...read2.body.data, music40: [...(read2.body.data.music40 || []), { id: 'M1', name: '音樂組一' }] }
}, AUTH);
check('先送出的人存成功', first.status === 200, `HTTP ${first.status}`);

const second = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: baseForBoth, // 他手上的版本已經過期了
  data: { ...read2.body.data, music40: [...(read2.body.data.music40 || []), { id: 'M2', name: '音樂組二' }] }
}, AUTH);
check('後送出的人被擋下（409 版本衝突）', second.status === 409, `HTTP ${second.status}`);
check('錯誤碼說得出是版本衝突', second.body.error === 'revision_conflict', String(second.body.error));

// 關鍵：被擋下的那個不能偷偷蓋掉別人的資料
const read3 = await getJson(server.url, '/api/data', AUTH);
const musicIds = (read3.body.data?.music40 || []).map(item => item.id);
check('被擋下的那次沒有寫進去（不是靜默覆蓋）', !musicIds.includes('M2'), musicIds.join(','));
check('成功的那次有寫進去', musicIds.includes('M1'));
check('前面存的個案也還在（沒有被整批蓋掉）',
  (read3.body.data?.optBone || []).some(item => item.id === 'S001'));

// 重新載入後重試，這次會成功 —— 這是使用者實際會做的動作
const retry = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: Number(read3.body.revision),
  data: { ...read3.body.data, music40: [...(read3.body.data.music40 || []), { id: 'M2', name: '音樂組二' }] }
}, AUTH);
check('重新載入後再存一次就成功', retry.status === 200, `HTTP ${retry.status}`);

const read4 = await getJson(server.url, '/api/data', AUTH);
const finalMusic = (read4.body.data?.music40 || []).map(item => item.id);
check('兩筆最後都在（沒有誰的資料消失）',
  finalMusic.includes('M1') && finalMusic.includes('M2'), finalMusic.join(','));

// === 5. 沒登入的人 ===
console.log('\n5. 沒登入的人什麼都看不到');

const noToken = await getJson(server.url, '/api/data');
check('沒帶 token 讀不到資料', noToken.status === 401, `HTTP ${noToken.status}`);

const badToken = await getJson(server.url, '/api/data', { authorization: 'Bearer not-a-real-token' });
check('假 token 也讀不到資料', [401, 403].includes(badToken.status), `HTTP ${badToken.status}`);

const noTokenWrite = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: Number(read4.body.revision),
  data: read4.body.data
});
check('沒帶 token 存不進去', [401, 403].includes(noTokenWrite.status), `HTTP ${noTokenWrite.status}`);

// === 6. 壞資料要被擋下 ===
console.log('\n6. 格式不對的資料要被擋下');

const badPayload = await postJson(server.url, '/api/data', {
  requestId: 'not-a-uuid',
  baseRevision: 'not-a-number',
  data: 'not-an-object'
}, AUTH);
check('亂送的資料回 422 而不是 500', badPayload.status === 422, `HTTP ${badPayload.status}`);
check('回應說得出哪裡不對', badPayload.body.error === 'invalid_change');

const badShape = await postJson(server.url, '/api/data', {
  requestId: crypto.randomUUID(),
  baseRevision: Number(read4.body.revision),
  data: { optBone: 'this should be an array' }
}, AUTH);
check('資料結構不對（該是陣列的給字串）也被擋下', badShape.status === 422, `HTTP ${badShape.status}`);

await server.close();

console.log(`\n設定後日常使用：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
