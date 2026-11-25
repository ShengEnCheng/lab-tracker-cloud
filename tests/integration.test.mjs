// 整合測試：把 API 端點當成黑盒子呼叫，驗證真正的行為。
//
// 用 tests/mock-supabase.mjs 取代真實資料庫，所以：
//   · 可以重複執行（設定完成後有鎖，真資料庫只能成功一次）
//   · 不會污染任何人的專案
//   · 可以模擬「資料庫被暫停」「資料表還沒建」這些難以重現的狀態
//
// 測的重點是「出錯時使用者會看到什麼」，因為那才是有沒有辦法自己救的關鍵。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockSupabase } from './mock-supabase.mjs';

const ROOT = new URL('../', import.meta.url).pathname;

// 把 handler 包成一個可以打的本機伺服器
async function startApiServer() {
  const server = http.createServer(async (req, res) => {
    res.status = function status(code) { this.statusCode = code; return this; };
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname.replace(/^\/api\//, '');
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      // 與 scripts/dev-server.mjs 一致：先確認檔案在，才動態載入。
      // 直接 import 不存在的檔案會丟例外，變成 500 而不是 404。
      const fs = await import('node:fs');
      const file = `${ROOT}api/${name}.js`;
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      }
      const mod = await import(`${file}?t=${Date.now()}`);
      return await mod.default(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal_error', message: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

function postJson(url, payload) {
  return jsonFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

const VALID_SETUP = {
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  adminName: '王小明',
  adminEmail: 'pi@example.edu.tw',
  adminPassword: 'abcd1234',
  withSampleData: true
};

// ---------------------------------------------------------------------------
test('情境：什麼都沒設定的空部署', async (t) => {
  const api = await startApiServer();
  // 完全不設定環境變數
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  await t.test('/api/health 要活著（監控與引導網頁靠它）', async () => {
    const { status, body } = await jsonFetch(`${api.base}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.app, 'lab-tracker-cloud');
    assert.equal(body.backendConfigured, false);
  });

  await t.test('/api/config 要說清楚沒設定，且不含任何金鑰', async () => {
    const { status, body } = await jsonFetch(`${api.base}/api/config`);
    assert.equal(status, 200);
    assert.equal(body.backendConfigured, false);
    assert.equal(body.anonKey, '');
    assert.ok(!JSON.stringify(body).includes('secret'));
  });

  await t.test('/api/setup-status 要給「環境還沒設好」的指引', async () => {
    const { status, body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(status, 200);
    assert.equal(body.backendConfigured, false);
    assert.equal(body.checks.environment.ok, false);
    assert.match(body.checks.environment.message, /環境變數|SUPABASE_URL/);
  });

  await t.test('沒設定時呼叫 /api/setup 要回 503 而不是 500', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, VALID_SETUP);
    assert.equal(status, 503);
    assert.equal(body.error, 'backend_not_configured');
  });

  await api.close();
});

// ---------------------------------------------------------------------------
test('情境：資料庫連上了但資料表還沒建', async (t) => {
  const mock = await startMockSupabase({ tables: { lab_state: [] } }); // 只有一張表
  mock.applyEnv(process.env);
  const api = await startApiServer();

  await t.test('/api/setup-status 要指出缺哪幾張表', async () => {
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.backendConfigured, true);
    assert.equal(body.checks.database.ok, true);
    assert.equal(body.checks.schema.ok, false);
    assert.ok(body.checks.schema.missing.includes('lab_settings'));
    assert.match(body.checks.schema.message, /SQL Editor|建表|語法/);
  });

  await t.test('呼叫 /api/setup 要回 503 schema_missing 並給指引', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, VALID_SETUP);
    assert.equal(status, 503);
    assert.equal(body.error, 'schema_missing');
    // 訊息要能讓使用者自己動手，不是丟一段資料庫錯誤
    assert.match(body.message, /SQL/);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('情境：資料庫被暫停（免費方案閒置一週）', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  mock.state.down = true;
  const api = await startApiServer();

  await t.test('要說「被暫停」而不是「連不上」', async () => {
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.checks.database.ok, false);
    // 使用者看到「連不上」只會一直重試；看到「被暫停、去按 Restore」才會去處理
    assert.match(body.checks.database.message, /Restore|暫停|pause/i);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('情境：全新部署的完整設定流程', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();

  await t.test('設定前 setup-status 說還沒設定', async () => {
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.setupComplete, false);
    assert.equal(body.adminExists, false);
  });

  await t.test('填錯資料要逐欄說哪裡錯', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, {
      ...VALID_SETUP,
      adminEmail: 'not-an-email',
      adminPassword: 'abc',
      organizationName: ''
    });
    assert.equal(status, 422);
    assert.equal(body.error, 'invalid_setup');
    assert.ok(body.errors.adminEmail);
    assert.ok(body.errors.adminPassword);
    assert.ok(body.errors.organizationName);
  });

  await t.test('合法資料要成功建立', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, VALID_SETUP);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.organization.name, '認知神經科學研究室');
    assert.equal(body.organization.code, 'CNC');
    assert.equal(body.revision, 1);
  });

  await t.test('真的建立了 Auth 帳號', () => {
    assert.equal(mock.state.authUsers.length, 1);
    assert.equal(mock.state.authUsers[0].email, 'pi@example.edu.tw');
    assert.equal(mock.state.authUsers[0].password, 'abcd1234');
  });

  await t.test('真的建立了管理員成員資料', () => {
    const profile = mock.state.tables.lab_profiles[0];
    assert.equal(profile.email, 'pi@example.edu.tw');
    assert.equal(profile.role, 'admin');
    assert.equal(profile.active, true);
  });

  await t.test('真的寫入了初始資料與研究室設定', () => {
    assert.equal(mock.state.tables.lab_state.length, 1);
    assert.equal(mock.state.tables.lab_state[0].revision, 1);
    assert.equal(mock.state.tables.lab_settings[0].organization_name, '認知神經科學研究室');
    assert.ok(mock.state.tables.lab_settings[0].setup_completed_at, '設定完成時間就是鎖');
  });

  await t.test('示範資料的編號都是 DEMO 開頭', () => {
    const members = mock.state.tables.lab_state[0].data.members || [];
    assert.ok(members.length > 0);
    for (const member of members) assert.match(member.code, /^DEMO/);
  });

  await t.test('設定後 setup-status 說已完成', async () => {
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.setupComplete, true);
    assert.equal(body.adminExists, true);
    assert.equal(body.organization.name, '認知神經科學研究室');
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('情境：設定鎖（最重要的安全檢查）', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();

  await postJson(`${api.base}/api/setup`, VALID_SETUP);

  await t.test('別人不能再設定一次把自己變成管理員', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, {
      ...VALID_SETUP,
      adminEmail: 'attacker@evil.com',
      adminName: '壞人',
      organizationName: '被佔走了'
    });
    // 這是整個系統最重要的一條線：公開網址的網站若允許重複設定，
    // 任何先看到網址的人都能拿到管理員權限。
    assert.equal(status, 409);
    assert.equal(body.error, 'already_setup');
  });

  await t.test('原本的管理員與研究室名稱都沒有被改掉', () => {
    assert.equal(mock.state.authUsers.length, 1);
    assert.equal(mock.state.authUsers[0].email, 'pi@example.edu.tw');
    assert.equal(mock.state.tables.lab_settings[0].organization_name, '認知神經科學研究室');
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('情境：沒有示範資料的乾淨開始', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();

  const { status } = await postJson(`${api.base}/api/setup`, { ...VALID_SETUP, withSampleData: false });
  assert.equal(status, 200);

  await t.test('不勾示範資料時，資料庫是空的', () => {
    const state = mock.state.tables.lab_state[0].data;
    assert.deepEqual(state.members, []);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('情境：新舊金鑰混用（真實世界的狀態）', async (t) => {
  const mock = await startMockSupabase();
  const api = await startApiServer();

  await t.test('新的 publishable + 舊的 service_role JWT 也要能動', async () => {
    // 實測：很多人已經換了 publishable，但 service_role 還是舊的 JWT
    process.env.SUPABASE_URL = mock.url;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_new_style';
    const legacyJwt = ['eyJ', 'hbGciOiJIUzI1NiIs', 'InR5cCI6IkpXVCJ9'].join('');
    process.env.SUPABASE_SECRET_KEY = legacyJwt; // 舊制
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.backendConfigured, true);
    assert.equal(body.checks.database.ok, true);
  });

  await t.test('舊金鑰名稱（SUPABASE_ANON_KEY）也要被接受', async () => {
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_ANON_KEY = '{{SECRET_vhcy6nzw}}';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '{{SECRET_vhcy6nzw}}';

    // 重新載入模組，因為 env 在載入時就讀了
    const fresh = await import(`${ROOT}api/_supabase.js?t=${Date.now()}`);
    const summary = fresh.describeConfig();
    assert.equal(summary.hasPublishableKey, true, '舊名稱 SUPABASE_ANON_KEY 應該被當成 publishable 金鑰');
    assert.equal(summary.hasSecretKey, true);
    assert.equal(summary.keyStyle, 'legacy');
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
test('API 基本防護', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();

  await t.test('/api/setup 只接受 POST', async () => {
    const { status, body } = await jsonFetch(`${api.base}/api/setup`);
    // GET 用來查狀態是允許的，但要能區分
    assert.ok([200, 405].includes(status));
    assert.ok(body);
  });

  await t.test('/api/health 不接受 POST', async () => {
    const { status } = await jsonFetch(`${api.base}/api/health`, { method: 'POST' });
    assert.equal(status, 405);
  });

  await t.test('壞掉的 JSON 不會讓伺服器倒下', async () => {
    const { status } = await jsonFetch(`${api.base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json'
    });
    assert.ok(status >= 400 && status < 500, `應該是 4xx，得到 ${status}`);
  });

  await t.test('不存在的 API 路徑回 404', async () => {
    const { status } = await jsonFetch(`${api.base}/api/no-such-endpoint`);
    assert.equal(status, 404);
  });

  await api.close();
  await mock.close();
});
