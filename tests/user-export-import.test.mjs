// 用「使用者真的上傳的那一份匯出檔」驗證新系統能不能收。
//
// 這支測試的資料來源不是自己造的測資，而是使用者從現在的線上系統
// （zheng-lab-tracker）實際按下「匯出」得到的檔案。使用者問的是
// 「這個是否可以匯入」——所以就用那一份，不重新捏一份看起來像的。
//
// 走的是真正的路：
//   1. 空的新系統 → 完成設定（建立管理員）
//   2. 登入拿 token
//   3. 把這份檔案原封不動 POST 到 /api/import
//   4. 確認匯入成功、資料內容與檔案一致、重複匯入不會變成兩份
//   5. 確認「空檔案」不會把系統弄壞，也不會把管理員弄不見

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSupabase } from './mock-supabase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 使用者上傳的那份匯出檔（由測試環境的附件路徑提供；找不到就跳過，
// 不要讓這支測試在別人的機器上因為沒有那個檔案而失敗）
const USER_EXPORT = process.env.USER_EXPORT_PATH
  || '/Users/shengenmacmini/.dsh/attachments/v1/files/97/9773d0459338d7f9b58cf4af95f83425876024b9874d71a24b009b546a72e074/zheng-lab-dashboard-backup-2026-11-25T15-55-35-694Z.json';

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
  return { server, mock, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, pathname, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + pathname, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

// 前端的登入是直接打 Supabase Auth（不經過我們的 API），所以照著這樣做。
async function login(mockUrl, email, password) {
  const response = await fetch(`${mockUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(USER_EXPORT)) {
  console.log(`跳過：找不到使用者上傳的匯出檔（${USER_EXPORT}）`);
  process.exit(0);
}

// 前端匯入時是 `requestId: crypto.randomUUID()`，格式不對會被 422 擋下。
const REQ_IMPORT_1 = '11111111-1111-4111-8111-111111111111';
const REQ_IMPORT_2 = '22222222-2222-4222-8222-222222222222';
const REQ_BAD = '33333333-3333-4333-8333-333333333333';
const REQ_RICH = '44444444-4444-4444-8444-444444444444';
const REQ_EMPTY_AGAIN = '55555555-5555-4555-8555-555555555555';

// 另一份「真的含資料」的匯出檔（從線上系統實際按匯出得到的 12+12+1 筆）
const RICH_EXPORT = process.env.RICH_EXPORT_PATH || '/tmp/handoff-artifacts/live-export.json';

const raw = fs.readFileSync(USER_EXPORT, 'utf8');
const userData = JSON.parse(raw);

console.log('\n【這份檔案裡有什麼】');
console.log(`  檔案：${path.basename(USER_EXPORT)}`);
console.log(`  大小：${Buffer.byteLength(raw)} bytes`);
console.log(`  成員：${(userData.members || []).length} 位${(userData.members || []).length ? `（${userData.members.map(m => m.id).join('、')}）` : ''}`);
console.log(`  OPT_Bone：${(userData.optBone || []).length} 筆`);
console.log(`  music40：${(userData.music40 || []).length} 筆`);
console.log(`  自訂研究案：${(userData.customStudies || []).length} 案`);
console.log(`  schemaVersion：${userData.schemaVersion}`);
console.log(`  匯出時間：${userData.exportedAt}`);

const { server, mock, base } = await startServer();
try {
  // ── 1. 空的新系統：先完成設定 ──────────────────────────────────────
  console.log('\n【新系統：完成設定】');
  const setup = await post(base, '/api/setup', {
    organizationName: '測試研究室',
    organizationCode: 'TEST',
    adminName: '測試管理員',
    adminEmail: 'new-admin@example.edu.tw',
    adminPassword: 'password1234',
    withSampleData: false
  });
  check('完成設定', setup.status === 200 || setup.status === 201, `HTTP ${setup.status} ${JSON.stringify(setup.payload).slice(0, 120)}`);

  const session = await login(mock.url, 'new-admin@example.edu.tw', 'password1234');
  check('可以登入', session.status === 200, `HTTP ${session.status}`);
  const token = session.payload.access_token;
  check('拿到登入權杖', typeof token === 'string' && token.length > 0);

  // ── 2. 空系統的初始狀態 ────────────────────────────────────────────
  const before = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
  const beforePayload = await before.json();
  check('空系統的資料是空的', (beforePayload.data?.optBone || []).length === 0);

  // 「誰能登入、名冊有誰」的權威來源是 lab_profiles（真正的帳號），
  // 不是資料檔裡的 members 陣列。資料檔的 members 只是顯示用的快照。
  const beforeProfiles = await fetch(`${base}/api/profiles`, { headers: { authorization: `Bearer ${token}` } });
  const beforeProfilesPayload = await beforeProfiles.json();
  check('空系統的名冊有剛建立的管理員',
    (beforeProfilesPayload.profiles || []).length === 1,
    JSON.stringify((beforeProfilesPayload.profiles || []).map(p => p.member_code)));
  check('名冊用的是研究室代碼 TEST',
    (beforeProfilesPayload.profiles || [])[0]?.member_code === 'TEST',
    (beforeProfilesPayload.profiles || [])[0]?.member_code);

  // ── 3. 用使用者那份檔案原封不動匯入 ────────────────────────────────
  console.log('\n【把使用者那份檔案原封不動匯入】');
  const importResult = await post(base, '/api/import', {
    requestId: REQ_IMPORT_1,
    data: userData
  }, token);
  check('匯入成功', importResult.status === 200, `HTTP ${importResult.status} ${JSON.stringify(importResult.payload).slice(0, 200)}`);

  // ── 4. 匯入後資料要跟檔案一致 ──────────────────────────────────────
  const after = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
  const afterPayload = await after.json();
  const data = afterPayload.data || {};

  check('OPT_Bone 筆數與檔案一致',
    (data.optBone || []).length === (userData.optBone || []).length,
    `${(data.optBone || []).length} / ${(userData.optBone || []).length}`);
  check('music40 筆數與檔案一致',
    (data.music40 || []).length === (userData.music40 || []).length,
    `${(data.music40 || []).length} / ${(userData.music40 || []).length}`);
  check('自訂研究案數量與檔案一致',
    (data.customStudies || []).length === (userData.customStudies || []).length);
  check('版本號有往上加', Number(afterPayload.revision) > Number(beforePayload.revision),
    `${beforePayload.revision} → ${afterPayload.revision}`);

  // 最關鍵的一項：匯入的成員名單不能把新系統的管理員蓋掉。
  // 權威來源是 lab_profiles，所以驗這裡。
  const afterProfiles = await fetch(`${base}/api/profiles`, { headers: { authorization: `Bearer ${token}` } });
  const afterProfilesPayload = await afterProfiles.json();
  const profileCodes = (afterProfilesPayload.profiles || []).map(p => p.member_code);
  check('匯入後真正的帳號名冊沒有被檔案裡的成員蓋掉',
    profileCodes.length === 1 && profileCodes[0] === 'TEST',
    JSON.stringify(profileCodes));
  check('匯入後登入身分沒有被換掉',
    (afterProfilesPayload.profiles || [])[0]?.email === 'new-admin@example.edu.tw',
    (afterProfilesPayload.profiles || [])[0]?.email);

  // 資料檔裡的 members 會被原樣保存（那是歷史快照），但畫面上的名冊
  // 會用 lab_profiles 重建 —— 所以即使這裡留著 admin，畫面也不會顯示它。
  console.log(`    （資料檔的 members 快照：${JSON.stringify((data.members || []).map(m => m.id))}，畫面會用真帳號重建）`);

  // ── 5. 同一份檔案再匯入一次，不能變成兩份 ──────────────────────────
  console.log('\n【重複匯入同一份檔案】');
  const again = await post(base, '/api/import', {
    requestId: REQ_IMPORT_1, data: userData
  }, token);
  check('同一個 requestId 重複匯入不會報錯', again.status === 200, `HTTP ${again.status}`);

  const afterAgain = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
  const againData = (await afterAgain.json()).data || {};
  check('重複匯入不會讓個案變成兩份',
    (againData.optBone || []).length === (userData.optBone || []).length,
    `${(againData.optBone || []).length} 筆`);

  // 換一個 requestId 再匯入 —— 這次是真的再把同一份內容寫一次。
  // 因為檔案裡是空的，結果應該還是空的（不會冒出重複的資料）。
  const secondImport = await post(base, '/api/import', {
    requestId: REQ_IMPORT_2, data: userData
  }, token);
  check('換 requestId 再匯入同一份內容也成功', secondImport.status === 200, `HTTP ${secondImport.status}`);

  // ── 6. 這份檔案是空的，系統不能因此壞掉 ────────────────────────────
  console.log('\n【匯入之後系統還能正常用】');
  const health = await fetch(`${base}/api/health`);
  const healthPayload = await health.json();
  check('健康檢查正常', health.status === 200 && healthPayload.status === 'ok');

  const stillCanLogin = await login(mock.url, 'new-admin@example.edu.tw', 'password1234');
  check('匯入後仍然可以登入', stillCanLogin.status === 200, `HTTP ${stillCanLogin.status}`);

  const profiles = await fetch(`${base}/api/profiles`, { headers: { authorization: `Bearer ${token}` } });
  const profilesPayload = await profiles.json();
  check('匯入後成員帳號還在', (profilesPayload.profiles || []).length === 1,
    JSON.stringify((profilesPayload.profiles || []).map(p => p.member_code)));

  // ── 6b. 換成「真的有很多資料」的檔案再匯入一次 ──────────────────────
  // 使用者這次上傳的檔案是空的（這也是我們要讓他知道的），但光驗一份空檔案
  // 不足以證明匯入沒問題。所以再拿一份真的含 12+12+1 筆資料的匯出檔跑一次。
  console.log('\n【換成真有資料的檔案（12 筆 OPT + 12 筆 music40 + 1 個研究案）】');
  if (fs.existsSync(RICH_EXPORT)) {
    const richRaw = fs.readFileSync(RICH_EXPORT, 'utf8');
    const richData = JSON.parse(richRaw);
    console.log(`  檔案：${path.basename(RICH_EXPORT)}（${Buffer.byteLength(richRaw)} bytes）`);
    console.log(`  成員 ${(richData.members || []).length} 位、OPT_Bone ${(richData.optBone || []).length} 筆、music40 ${(richData.music40 || []).length} 筆、自訂研究案 ${(richData.customStudies || []).length} 案`);

    const richImport = await post(base, '/api/import', {
      requestId: REQ_RICH,
      data: richData
    }, token);
    check('有資料的檔案也能匯入', richImport.status === 200, `HTTP ${richImport.status} ${JSON.stringify(richImport.payload).slice(0, 160)}`);

    const richAfter = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
    const richAfterData = (await richAfter.json()).data || {};
    check('OPT_Bone 12 筆都在',
      (richAfterData.optBone || []).length === richData.optBone.length,
      `${(richAfterData.optBone || []).length} / ${richData.optBone.length}`);
    check('music40 12 筆都在',
      (richAfterData.music40 || []).length === richData.music40.length,
      `${(richAfterData.music40 || []).length} / ${richData.music40.length}`);
    check('自訂研究案 1 案還在',
      (richAfterData.customStudies || []).length === richData.customStudies.length,
      `${(richAfterData.customStudies || []).length} / ${richData.customStudies.length}`);

    // 逐欄位比對第一筆，確認不是只有筆數對
    const richFirst = richAfterData.optBone?.[0] || {};
    const fileFirst = richData.optBone[0];
    const sameFields = Object.keys(fileFirst).every(key => JSON.stringify(richFirst[key]) === JSON.stringify(fileFirst[key]));
    check('第一筆的每一個欄位都一字不差', sameFields,
      sameFields ? '' : `檔案 ${JSON.stringify(fileFirst).slice(0, 120)} / 匯入後 ${JSON.stringify(richFirst).slice(0, 120)}`);

    const richCustom = richAfterData.customStudies?.[0] || {};
    check('自訂研究案的里程碑數量一致',
      (richCustom.milestones || []).length === (richData.customStudies[0].milestones || []).length,
      `${(richCustom.milestones || []).length} / ${(richData.customStudies[0].milestones || []).length}`);
    check('自訂研究案的個案數量一致',
      (richCustom.subjects || []).length === (richData.customStudies[0].subjects || []).length);

    // 再驗一次：匯入大量資料之後，真正的帳號名冊仍然不受影響
    const richProfiles = await fetch(`${base}/api/profiles`, { headers: { authorization: `Bearer ${token}` } });
    const richProfileCodes = ((await richProfiles.json()).profiles || []).map(p => p.member_code);
    check('匯入大量資料後帳號名冊仍然沒被覆蓋',
      richProfileCodes.length === 1 && richProfileCodes[0] === 'TEST',
      JSON.stringify(richProfileCodes));

    const richLogin = await login(mock.url, 'new-admin@example.edu.tw', 'password1234');
    check('匯入大量資料後仍然可以登入', richLogin.status === 200, `HTTP ${richLogin.status}`);
  } else {
    console.log(`  （跳過：找不到 ${RICH_EXPORT}）`);
  }

  // ── 7. 壞格式要被擋下，而且不能弄壞現有資料 ────────────────────────
  console.log('\n【壞掉的檔案會被擋下】');
  const bad = await post(base, '/api/import', {
    requestId: REQ_BAD,
    data: { optBone: 'not-an-array', music40: [] }
  }, token);
  check('格式錯誤的檔案回 422', bad.status === 422, `HTTP ${bad.status} ${JSON.stringify(bad.payload).slice(0, 150)}`);
  check('錯誤訊息會說明哪裡不對',
    JSON.stringify(bad.payload).includes('optBone') || JSON.stringify(bad.payload).includes('陣列'),
    JSON.stringify(bad.payload).slice(0, 150));

  const afterBad = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
  const afterBadData = (await afterBad.json()).data || {};
  // 此刻畫面上的資料是上一段匯入的 12 筆（不是使用者那份空檔案）。
  const expectedRows = fs.existsSync(RICH_EXPORT)
    ? JSON.parse(fs.readFileSync(RICH_EXPORT, 'utf8')).optBone.length
    : (userData.optBone || []).length;
  check('壞檔案沒有弄壞現有資料',
    (afterBadData.optBone || []).length === expectedRows,
    `${(afterBadData.optBone || []).length} 筆（應為 ${expectedRows}）`);

  // 這一項是給使用者看的重點：匯入會「整份取代」，不是「合併」。
  // 所以拿一份空檔案去匯入，會把原有資料清空 —— 這需要講清楚。
  console.log('\n【匯入是整份取代，不是合併】');
  const replaceCheck = await post(base, '/api/import', {
    requestId: REQ_EMPTY_AGAIN,
    data: { ...userData }
  }, token);
  const afterEmpty = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${token}` } });
  const afterEmptyData = (await afterEmpty.json()).data || {};
  console.log(`  拿空檔案再匯入一次 → HTTP ${replaceCheck.status}，個案 ${(afterEmptyData.optBone || []).length} 筆`);
  console.log('  （這是預期的：匯入等於整份取代。使用者要拿「有資料的那份」去匯入。）');

  // ── 8. 沒登入不能匯入 ──────────────────────────────────────────────
  const anonymous = await post(base, '/api/import', { requestId: REQ_IMPORT_1, data: userData });
  check('沒登入不能匯入（401）', anonymous.status === 401, `HTTP ${anonymous.status}`);

} finally {
  await new Promise(resolve => server.close(resolve));
  await mock.close?.();
}

console.log(`\n使用者匯出檔匯入測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
