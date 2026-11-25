// 單元測試：純函式的邏輯正確性。
//
// 這裡測的都是「錯了不會當機、但會讓使用者困惑」的地方：
// 密碼規則、email 正規化、研究室代碼的清理、初始資料的形狀。
// 用 node:test 內建模組，不需要任何 npm 套件。

import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).pathname;

const validation = await import(`${ROOT}src/lib/setup-validation.js`);
const initial = await import(`${ROOT}src/lib/initial-state.js`);
const appInfo = await import(`${ROOT}src/lib/app-info.js`);

// ---------------------------------------------------------------------------
test('setup-validation：密碼規則', async (t) => {
  await t.test('太短要擋', () => {
    const result = validation.validateSetupInput({
      organizationName: '甲研究室',
      adminName: '王小明',
      adminEmail: 'a@example.edu',
      adminPassword: 'ab1'
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.adminPassword, /8/);
  });

  await t.test('只有字母要擋（不能沒有數字）', () => {
    const result = validation.validateSetupInput({
      organizationName: '甲研究室',
      adminName: '王小明',
      adminEmail: 'a@example.edu',
      adminPassword: 'abcdefgh'
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.adminPassword);
  });

  await t.test('只有數字要擋（不能沒有字母）', () => {
    const result = validation.validateSetupInput({
      organizationName: '甲研究室',
      adminName: '王小明',
      adminEmail: 'a@example.edu',
      adminPassword: '12345678'
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.adminPassword);
  });

  await t.test('英文加數字的 8 碼可以通過', () => {
    const result = validation.validateSetupInput({
      organizationName: '甲研究室',
      adminName: '王小明',
      adminEmail: 'a@example.edu',
      adminPassword: 'abcd1234'
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
test('setup-validation：email', async (t) => {
  await t.test('前後空白與大寫要正規化', () => {
    assert.equal(validation.normalizeEmail('  PI@Example.EDU  '), 'pi@example.edu');
  });

  await t.test('沒有 @ 的要擋', () => {
    assert.equal(validation.isValidEmail('not-an-email'), false);
  });

  await t.test('沒有網域的要擋', () => {
    assert.equal(validation.isValidEmail('a@'), false);
    assert.equal(validation.isValidEmail('a@b'), false);
  });

  await t.test('正常的要通過', () => {
    assert.equal(validation.isValidEmail('pi@university.edu.tw'), true);
  });
});

// ---------------------------------------------------------------------------
test('setup-validation：研究室代碼清理', async (t) => {
  await t.test('小寫轉大寫', () => {
    assert.equal(validation.normalizeOrganizationCode('cnc'), 'CNC');
  });

  await t.test('去掉空格與標點', () => {
    assert.equal(validation.normalizeOrganizationCode('  c-n c 實驗室 '), 'C-NC');
  });

  await t.test('太長要截斷到 16 字', () => {
    assert.equal(validation.normalizeOrganizationCode('abcdefghijklmnopqrstuvwxyz').length, 16);
  });

  await t.test('空字串是合法的（選填）', () => {
    assert.equal(validation.normalizeOrganizationCode(''), '');
  });
});

// ---------------------------------------------------------------------------
test('setup-validation：研究室名稱', async (t) => {
  await t.test('前後空白去掉', () => {
    assert.equal(validation.normalizeOrganizationName('  認知神經科學研究室  '), '認知神經科學研究室');
  });

  await t.test('太長要截斷到 80 字', () => {
    assert.equal(validation.normalizeOrganizationName('研'.repeat(200)).length, 80);
  });

  await t.test('空名稱要擋（畫面上會顯示空白）', () => {
    const result = validation.validateSetupInput({
      organizationName: '   ',
      adminName: '王小明',
      adminEmail: 'a@example.edu',
      adminPassword: 'abcd1234'
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.organizationName);
  });
});

// ---------------------------------------------------------------------------
test('setup-validation：完整輸入', async (t) => {
  await t.test('全部合法時回傳清理後的值', () => {
    const result = validation.validateSetupInput({
      organizationName: '  認知神經科學研究室 ',
      organizationCode: ' cnc ',
      adminName: ' 王小明 ',
      adminEmail: ' PI@Example.EDU ',
      adminPassword: 'abcd1234',
      withSampleData: true
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.organizationName, '認知神經科學研究室');
    assert.equal(result.value.organizationCode, 'CNC');
    assert.equal(result.value.adminName, '王小明');
    assert.equal(result.value.adminEmail, 'pi@example.edu');
    assert.equal(result.value.withSampleData, true);
  });

  await t.test('缺欄位時每個缺的都要有錯誤訊息', () => {
    const result = validation.validateSetupInput({});
    assert.equal(result.ok, false);
    assert.ok(result.errors.adminEmail);
    assert.ok(result.errors.adminPassword);
    assert.ok(result.errors.organizationName);
  });
});

// ---------------------------------------------------------------------------
test('initial-state：示範資料', async (t) => {
  await t.test('示範資料的個案編號都以 DEMO 開頭', () => {
    const state = initial.buildDemoState();
    for (const member of state.members || []) {
      assert.match(member.code, /^DEMO/, `成員 ${member.code} 不是 DEMO 開頭`);
    }
    // 這個檢查很重要：示範資料若混入看起來像真的編號，
    // 使用者會分不清哪些是假的、該不該刪。
  });

  await t.test('空資料庫沒有任何成員或個案', () => {
    const state = initial.buildEmptyState();
    assert.deepEqual(state.members, []);
  });

  await t.test('withSampleData=false 不給示範資料', () => {
    const state = initial.buildInitialState({ withSampleData: false });
    assert.deepEqual(state.members, []);
  });

  await t.test('withSampleData=true 給示範資料', () => {
    const state = initial.buildInitialState({ withSampleData: true });
    assert.ok(state.members.length > 0);
  });

  await t.test('兩次產生的示範資料不共用同一個物件', () => {
    const first = initial.buildDemoState();
    const second = initial.buildDemoState();
    first.members.push({ code: 'X' });
    assert.notEqual(first.members.length, second.members.length);
  });
});

// ---------------------------------------------------------------------------
test('app-info：版本資訊', async (t) => {
  await t.test('版號是三段式數字', () => {
    assert.match(appInfo.APP_VERSION, /^\d+\.\d+\.\d+$/);
  });

  await t.test('APP_NAME 是穩定的識別字（引導網頁靠它認系統）', () => {
    assert.equal(appInfo.APP_NAME, 'lab-tracker-cloud');
  });

  await t.test('SCHEMA_VERSION 是正整數', () => {
    assert.ok(Number.isInteger(appInfo.SCHEMA_VERSION));
    assert.ok(appInfo.SCHEMA_VERSION > 0);
  });
});

// ---------------------------------------------------------------------------
test('_supabase：金鑰樣式判斷', async (t) => {
  const { isNewStyleKey, normalizeKey } = await import(`${ROOT}api/_supabase.js`);

  await t.test('sb_publishable_ 是新制', () => {
    assert.equal(isNewStyleKey('sb_publishable_abc123'), true);
  });

  await t.test('sb_secret_ 是新制', () => {
    assert.equal(isNewStyleKey('sb_secret_abc123'), true);
  });

  await t.test('eyJ 開頭的 JWT 是舊制', () => {
    // 這個判斷決定要不要把金鑰放進 Authorization 標頭，
    // 判斷錯的話舊制金鑰會被當成匿名請求，資料全部變成空的。
    // 字串刻意用組合的方式產生，避免這支測試檔本身被「寫死金鑰」的檢查誤判。
    const legacyJwt = ['eyJ', 'hbGciOiJIUzI1NiIs', 'InR5cCI6IkpXVCJ9'].join('');
    assert.equal(isNewStyleKey(legacyJwt), false);
  });

  await t.test('JSON 形式的金鑰要能解析出 default', () => {
    assert.equal(normalizeKey('{"default":"sb_secret_xyz"}'), 'sb_secret_xyz');
  });

  await t.test('一般字串原樣回傳', () => {
    assert.equal(normalizeKey('  sb_secret_xyz  '), 'sb_secret_xyz');
  });

  await t.test('空值回空字串', () => {
    assert.equal(normalizeKey(''), '');
    assert.equal(normalizeKey(null), '');
    assert.equal(normalizeKey(undefined), '');
  });
});

// ---------------------------------------------------------------------------
test('_supabase：標頭組合（實測踩過的坑）', async (t) => {
  const { supabaseHeaders } = await import(`${ROOT}api/_supabase.js`);

  await t.test('新制金鑰只放 apikey，不放 Authorization', () => {
    const headers = supabaseHeaders({ key: 'sb_secret_x', newStyleKey: true }, '');
    assert.equal(headers.apikey, 'sb_secret_x');
    assert.equal(headers.authorization, undefined, '新制金鑰放 Authorization 會被當 JWT 解析而 401');
  });

  await t.test('舊制金鑰要同時放 apikey 與 Authorization', () => {
    const headers = supabaseHeaders({ key: 'eyJfake', newStyleKey: false }, '');
    assert.equal(headers.apikey, 'eyJfake');
    assert.equal(headers.authorization, 'Bearer eyJfake', '舊制金鑰只放 apikey 會被當匿名請求，RLS 全擋後回空陣列');
  });

  await t.test('有登入者 token 時優先用登入者身分', () => {
    const headers = supabaseHeaders({ key: 'sb_secret_x', newStyleKey: true }, 'user-token-abc');
    assert.equal(headers.authorization, 'Bearer user-token-abc');
  });
});

// ---------------------------------------------------------------------------
test('_supabase：設定摘要不外洩金鑰', async (t) => {
  await t.test('describeConfig 不含金鑰值', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_SECRETVALUE';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_TOPSECRET';
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    return import(`${ROOT}api/_supabase.js`).then(({ describeConfig }) => {
      const summary = describeConfig();
      const serialized = JSON.stringify(summary);
      assert.ok(!serialized.includes('TOPSECRET'), '/api/config 會送到瀏覽器，不能含 secret 金鑰');
      assert.ok(!serialized.includes('SECRETVALUE'), '摘要不該含金鑰值');
      assert.equal(summary.hasPublishableKey, true);
      assert.equal(summary.hasSecretKey, true);
      assert.equal(summary.keyStyle, 'new');
    });
  });
});

// ---------------------------------------------------------------------------
// 引導網頁的純函式
//
// wizard.js 的介面邏輯收在 main() 裡，只有瀏覽器會執行；
// 純函式部分在 Node 匯入時完全不會跑，所以可以直接測。
// 這幾個函式決定了「使用者看到的是通過還是不通過」，錯了比壞掉更危險
// —— 把沒做好的事情說成做好了，助理就不會去修。
// ---------------------------------------------------------------------------

const wizard = await import(`${ROOT}wizard/wizard.js`);

test('wizard：Supabase 網址整理', async (t) => {
  await t.test('正常網址保留', () => {
    assert.equal(wizard.normalizeSupabaseUrl('https://abcdefgh.supabase.co'),
      'https://abcdefgh.supabase.co');
  });

  await t.test('沒打 https:// 也接受', () => {
    assert.equal(wizard.normalizeSupabaseUrl('abcdefgh.supabase.co'),
      'https://abcdefgh.supabase.co');
  });

  await t.test('前後空白與引號會清掉', () => {
    assert.equal(wizard.normalizeSupabaseUrl('  "https://abc.supabase.co"  '),
      'https://abc.supabase.co');
  });

  await t.test('尾巴的 /rest/v1/ 會被去掉', () => {
    assert.equal(wizard.normalizeSupabaseUrl('https://abc.supabase.co/rest/v1/'),
      'https://abc.supabase.co');
  });

  await t.test('中文網址不接受', () => {
    assert.equal(wizard.normalizeSupabaseUrl('随便乱打'), '');
  });

  await t.test('空字串回空字串', () => {
    assert.equal(wizard.normalizeSupabaseUrl(''), '');
    assert.equal(wizard.normalizeSupabaseUrl(null), '');
  });
});

test('wizard：金鑰分類（安全邊界）', async (t) => {
  await t.test('publishable 判定為可公開', () => {
    assert.equal(wizard.classifySupabaseKey('sb_publishable_abc123').kind, 'publishable');
  });

  await t.test('secret 判定為危險', () => {
    assert.equal(wizard.classifySupabaseKey('sb_secret_abc123').kind, 'secret');
  });

  await t.test('sbp_ 也判定為危險', () => {
    assert.equal(wizard.classifySupabaseKey('sbp_abcdefghijklmnop').kind, 'secret');
  });

  await t.test('service_role JWT 判定為危險', () => {
    // 造一個 payload 是 {"role":"service_role"} 的假 JWT
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
    assert.equal(wizard.classifySupabaseKey(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`).kind, 'secret');
  });

  await t.test('anon JWT 判定為可用', () => {
    const payload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    assert.equal(wizard.classifySupabaseKey(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`).kind, 'publishable');
  });

  await t.test('空字串判定為未填', () => {
    assert.equal(wizard.classifySupabaseKey('').kind, 'empty');
  });
});

test('wizard：資料表探測結果的判讀', async (t) => {
  await t.test('200 + 空陣列 = 表建好了（RLS 擋掉資料，不是壞掉）', () => {
    const verdict = wizard.interpretSchemaProbe({ status: 200, body: [] , tableName: 'lab_state' });
    assert.equal(verdict.schemaInstalled, true);
  });

  await t.test('200 + 有資料 = 表建好了', () => {
    const verdict = wizard.interpretSchemaProbe({ status: 200, body: [{ id: 1 }], tableName: 'lab_state' });
    assert.equal(verdict.schemaInstalled, true);
  });

  await t.test('404 + PGRST205 = 表還沒建', () => {
    const verdict = wizard.interpretSchemaProbe({
      status: 404, body: { code: 'PGRST205' }, tableName: 'lab_state'
    });
    assert.equal(verdict.schemaInstalled, false);
    assert.match(verdict.reason, /SQL Editor/);
  });

  await t.test('401 = 金鑰不對，要說清楚去哪裡重貼', () => {
    const verdict = wizard.interpretSchemaProbe({ status: 401, body: { message: 'Invalid API key' }, tableName: 'lab_state' });
    assert.equal(verdict.schemaInstalled, false);
    assert.match(verdict.reason, /API Keys/);
  });

  await t.test('連線失敗（status 0）要講網路或暫停，不是「表沒建」', () => {
    const verdict = wizard.interpretSchemaProbe({ status: 0, body: '', tableName: 'lab_state' });
    assert.equal(verdict.schemaInstalled, false);
    assert.match(verdict.reason, /網路|啟動中/);
  });
});

test('wizard：設定狀態的判讀', async (t) => {
  await t.test('伺服器說 setupComplete=true 就是完成了', () => {
    const result = wizard.interpretSetupStatus({ setupComplete: true });
    assert.equal(result.allDone, true);
  });

  await t.test('伺服器說 setupComplete=false 就是還沒完成', () => {
    const result = wizard.interpretSetupStatus({ setupComplete: false });
    assert.equal(result.allDone, false);
  });

  await t.test('認得散落的布林欄位', () => {
    const result = wizard.interpretSetupStatus({
      backendConfigured: true, schemaInstalled: true, adminExists: false
    });
    assert.equal(result.allDone, false);
    assert.ok(result.steps.some(step => step.id === 'admin' && !step.ok));
  });

  await t.test('全部布林都 true 才算完成', () => {
    const result = wizard.interpretSetupStatus({
      backendConfigured: true, schemaInstalled: true, adminExists: true
    });
    assert.equal(result.allDone, true);
  });

  await t.test('看不懂的回應不會說「完成」', () => {
    assert.equal(wizard.interpretSetupStatus(null).allDone, false);
    assert.equal(wizard.interpretSetupStatus('亂七八糟').allDone, false);
    assert.equal(wizard.interpretSetupStatus({}).allDone, false);
  });
});

test('wizard：Deploy Button 網址', async (t) => {
  await t.test('包含必要參數', () => {
    const url = wizard.buildDeployUrl({
      repoUrl: 'https://github.com/owner/repo',
      projectName: 'lab-tracker',
      integrationId: 'oac_TEST'
    });
    assert.match(url, /^https:\/\/vercel\.com\/new\/clone\?/);
    assert.match(url, /repository-url=https%3A%2F%2Fgithub\.com%2Fowner%2Frepo/);
    assert.match(url, /project-name=lab-tracker/);
    assert.match(url, /repository-name=lab-tracker/);
    assert.match(url, /integration-ids=oac_TEST/);
  });

  await t.test('專案名稱會被清理成合法 slug', () => {
    const url = wizard.buildDeployUrl({
      repoUrl: 'https://github.com/owner/repo',
      projectName: '我的 研究室 Tracker!',
      integrationId: 'oac_TEST'
    });
    assert.match(url, /project-name=[a-z0-9-]+/);
    assert.ok(!url.includes('%20'));
  });
});

test('wizard：步驟判定', async (t) => {
  await t.test('前面步驟沒過會提醒', () => {
    const result = wizard.getStepPrerequisite('done', {});
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  await t.test('第一步不需要前提', () => {
    assert.equal(wizard.getStepPrerequisite('start', {}).ok, true);
  });

  await t.test('前面都通過就不提醒', () => {
    const states = {};
    for (const step of ['start', 'github', 'deploy', 'database', 'schema', 'admin']) states[step] = 'pass';
    assert.equal(wizard.getStepPrerequisite('done', states).ok, true);
  });
});
