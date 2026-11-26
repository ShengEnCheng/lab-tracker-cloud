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

// ---------------------------------------------------------------------------
// 舊制 service_role 金鑰（eyJ… 的 JWT）要放進 Authorization 才有伺服器權限。
// 曾經有四支 API 只放 apikey：用舊制金鑰的研究室「第一次設定」做不完、
// setup-status 永遠說「還沒設定」。mock 現在照真實行為模擬這件事。
test('情境：只有舊制 service_role 金鑰的研究室也能完整設定', async (t) => {
  const legacySecret = ['eyJ', 'hbGciOiJIUzI1NiIs', 'InR5cCI6IkpXVCJ9', '.legacy-service-role'].join('');
  const mock = await startMockSupabase({ secretKey: legacySecret });
  mock.applyEnv(process.env);
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const api = await startApiServer();

  await t.test('第一次設定成功', async () => {
    const { status, body } = await postJson(`${api.base}/api/setup`, VALID_SETUP);
    assert.equal(status, 200, JSON.stringify(body));
  });

  await t.test('setup-status 看得到「已完成」與管理員（不是被當成匿名讀到 []）', async () => {
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.setupComplete, true);
    assert.equal(body.adminExists, true);
  });

  await t.test('/api/config 讀得到研究室名稱', async () => {
    const { body } = await jsonFetch(`${api.base}/api/config`);
    assert.equal(body.setupComplete, true);
    assert.equal(body.organizationName, VALID_SETUP.organizationName);
  });

  await t.test('設定鎖仍然有效：不能再設定第二次', async () => {
    const { status } = await postJson(`${api.base}/api/setup`, { ...VALID_SETUP, adminEmail: 'attacker@example.com' });
    assert.equal(status, 409);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
// /api/profiles 曾經取 lab_profiles 的「第一列」當呼叫者的角色。RLS 讓每個
// 在職成員都讀得到所有人的資料列，第一列通常是管理員 —— 於是一般成員也被
// 當成管理員，能新增管理員、甚至重設管理員的密碼並拿到新密碼。
test('情境：一般成員不能透過 /api/profiles 提權', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();

  await postJson(`${api.base}/api/setup`, VALID_SETUP);
  const admin = mock.state.authUsers[0];
  const adminPasswordBefore = admin.password;

  // 建一位一般成員，並讓他登入
  const researcherId = '11111111-2222-4333-8444-555555555555';
  mock.state.authUsers.push({ id: researcherId, email: 'ra@example.edu.tw', password: 'ra-password-1', email_confirm: true });
  mock.state.tables.lab_profiles.push({ id: researcherId, email: 'ra@example.edu.tw', role: 'researcher', active: true });
  const token = `token-${researcherId}`;
  mock.state.authTokens.push(token);
  const asResearcher = (method, payload) => jsonFetch(`${api.base}/api/profiles`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: payload ? JSON.stringify(payload) : undefined
  });

  await t.test('一般成員可以看名冊', async () => {
    const { status } = await asResearcher('GET');
    assert.equal(status, 200);
  });

  await t.test('一般成員不能新增管理員', async () => {
    const { status } = await asResearcher('POST', { email: 'evil@example.com', role: 'admin' });
    assert.equal(status, 403);
    assert.ok(!mock.state.authUsers.some(user => user.email === 'evil@example.com'));
  });

  await t.test('一般成員不能拿管理員的 email「新增成員」來重設他的密碼', async () => {
    const { status, body } = await asResearcher('POST', { email: admin.email, role: 'researcher' });
    assert.equal(status, 403);
    assert.equal(body.generatedPassword, undefined);
    assert.equal(admin.password, adminPasswordBefore);
  });

  await t.test('一般成員不能把自己改成管理員', async () => {
    const { status } = await asResearcher('PATCH', { id: researcherId, email: 'ra@example.edu.tw', role: 'admin' });
    assert.equal(status, 403);
    assert.equal(mock.state.tables.lab_profiles.find(row => row.id === researcherId).role, 'researcher');
  });

  await t.test('假的 token 回 401（請重新登入），不是 403', async () => {
    const { status } = await jsonFetch(`${api.base}/api/profiles`, { headers: { authorization: 'Bearer not-a-real-token' } });
    assert.equal(status, 401);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
// 第 4 段（004）是權限的安全修正，只改函式，沒加表也沒加欄位。
// 已經在用的研究室不會自動套用，要靠這裡把「還沒補跑」講出來。
test('情境：已部署的研究室還沒補跑第 4 段（安全性修正）', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();
  await postJson(`${api.base}/api/setup`, VALID_SETUP);

  await t.test('補跑之前：setup-status 指出缺第四段', async () => {
    mock.state.schemaVersion = null;
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.securityFixReady, false);
    assert.equal(body.checks.schema.ok, false);
    assert.match(body.checks.schema.message, /第四段|004/);
    // 系統仍然可以使用：設定完成的判斷不受影響
    assert.equal(body.setupComplete, true);
  });

  await t.test('補跑之前：系統設定頁（update-policy）也知道', async () => {
    const { body } = await jsonFetch(`${api.base}/api/update-policy`);
    assert.equal(body.securityFixReady, false);
  });

  await t.test('補跑之後：一切正常', async () => {
    mock.state.schemaVersion = 4;
    const { body } = await jsonFetch(`${api.base}/api/setup-status`);
    assert.equal(body.securityFixReady, true);
    assert.equal(body.checks.schema.ok, true);
    const policy = await jsonFetch(`${api.base}/api/update-policy`);
    assert.equal(policy.body.securityFixReady, true);
  });

  await api.close();
  await mock.close();
});

// ---------------------------------------------------------------------------
// 每日備份只認 CRON_SECRET。沒設定時不能默默失敗：要回 503 並說清楚原因，
// 不然 Vercel 的排程紀錄只會看到一排 401，沒人知道備份從來沒跑過。
test('情境：每日備份的觸發權限', async (t) => {
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);
  const api = await startApiServer();
  await postJson(`${api.base}/api/setup`, VALID_SETUP);
  const savedSecret = process.env.CRON_SECRET;

  await t.test('沒設定 CRON_SECRET：回 503 cron_secret_missing，偽造的標頭也沒用', async () => {
    delete process.env.CRON_SECRET;
    const { status, body } = await jsonFetch(`${api.base}/api/backup`, { headers: { 'x-vercel-cron': '1' } });
    assert.equal(status, 503);
    assert.equal(body.error, 'cron_secret_missing');
    assert.match(body.message, /CRON_SECRET/);
  });

  await t.test('沒設定時，setup-status 與系統設定頁都會回報', async () => {
    delete process.env.CRON_SECRET;
    assert.equal((await jsonFetch(`${api.base}/api/setup-status`)).body.cronSecretConfigured, false);
    assert.equal((await jsonFetch(`${api.base}/api/update-policy`)).body.cronSecretConfigured, false);
  });

  await t.test('有設定時：只帶 x-vercel-cron 標頭會被擋（401）', async () => {
    process.env.CRON_SECRET = 'c'.repeat(64);
    const { status } = await jsonFetch(`${api.base}/api/backup`, { headers: { 'x-vercel-cron': '1' } });
    assert.equal(status, 401);
  });

  await t.test('有設定時：帶對的密碼不會被權限擋下', async () => {
    process.env.CRON_SECRET = 'c'.repeat(64);
    const { status } = await jsonFetch(`${api.base}/api/backup`, { headers: { authorization: `Bearer ${'c'.repeat(64)}` } });
    assert.notEqual(status, 401);
    assert.notEqual(status, 503);
  });

  if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
  await api.close();
  await mock.close();
});
