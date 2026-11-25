// 使用者真的要做的動作：按「⭱ 匯入」、選那份檔案、按確定。
//
// 前面的 user-export-import.test.mjs 走的是 HTTP 層（直接 POST /api/import），
// 但使用者不是這樣做的——他是在畫面上按按鈕。中間還有一層頁面自己的檢查
// （validateImportedData、摘要對話框、快照備份），任何一層出錯他都會卡住。
//
// 所以這支測試用真的 Chrome 開頁面，把那份檔案塞進 <input type="file">，
// 觸發 change，然後確認：
//   1. 頁面接受了這個檔案（沒有跳「格式不符」）
//   2. 摘要對話框的內容是對的
//   3. 確定之後資料真的被換成檔案裡的內容
//   4. 有先存一份「匯入前快照」（匯入失敗時唯一的退路）
//
// 用兩份檔案測：使用者上傳的那份（空的），以及一份真的含資料的。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const USER_EXPORT = process.env.USER_EXPORT_PATH
  || '/Users/shengenmacmini/.dsh/attachments/v1/files/97/9773d0459338d7f9b58cf4af95f83425876024b9874d71a24b009b546a72e074/zheng-lab-dashboard-backup-2026-11-25T15-55-35-694Z.json';
const RICH_EXPORT = process.env.RICH_EXPORT_PATH || '/tmp/handoff-artifacts/live-export.json';

if (!existsSync(USER_EXPORT)) {
  console.log(`跳過：找不到使用者上傳的匯出檔（${USER_EXPORT}）`);
  process.exit(0);
}

let failed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const html = readFileSync('index.html', 'utf8');

const REAL_PROFILES = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.edu.tw', display_name: '管理員', member_code: 'TEST', role: 'admin', active: true }
];

// 頁面上原本要有的資料（用來確認匯入真的把它換掉了）
const CURRENT_DATA = {
  schemaVersion: 1,
  members: [{ id: 'TEST', name: '管理員', role: 'admin' }],
  optBone: [
    { id: 'OLD-01', name: '匯入前就有的個案', status: '收案中', t1Date: '2026-08-01', t1Owner: 'TEST', t1Done: true }
  ],
  music40: [],
  customStudies: []
};

function buildPage(payloadJson, fileName) {
  const harness = `
<script>
window.__uiErrors = [];
window.__alerts = [];
window.__confirms = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

// 攔對話框：headless Chrome 裡 alert() 會真的卡住
window.alert = (message) => { window.__alerts.push(String(message)); };
window.confirm = (message) => { window.__confirms.push(String(message)); return true; };
window.__downloaded = [];
window.__originalCreateObjectURL = URL.createObjectURL;

const REAL_PROFILES = ${JSON.stringify(REAL_PROFILES)};
const CURRENT_DATA = ${JSON.stringify(CURRENT_DATA)};
const IMPORT_TEXT = ${JSON.stringify(payloadJson)};
const IMPORT_NAME = ${JSON.stringify(fileName)};

const STORAGE = 'LAB_TRACKER_STORAGE_V1';
localStorage.setItem(STORAGE, JSON.stringify(CURRENT_DATA));
localStorage.removeItem('LAB_TRACKER_LAST_IMPORT_SNAPSHOT');

window.__LAB_TRACKER_BACKEND__ = { enabled: true, apiBase: '/api', token: 'test-token' };
window.__LAB_TRACKER_AUTH__ = {
  setupComplete: true,
  organizationName: '測試研究室',
  organizationCode: 'TEST',
  supabaseUrl: 'https://test.supabase.co',
  anonKey: 'sb_publishable_test'
};
localStorage.setItem('LAB_TRACKER_AUTH_SESSION', JSON.stringify({
  access_token: 'test-token',
  user: { id: REAL_PROFILES[0].id, email: REAL_PROFILES[0].email },
  expires_at: Math.floor(Date.now() / 1000) + 3600
}));

window.__importRequests = [];
window.fetch = async (url, options) => {
  const target = String(url);
  const respond = (body, status = 200) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body)
  });
  if (target.includes('/api/config')) {
    return respond({
      app: '研究室追蹤系統', version: '1.0.0', backendConfigured: true, setupComplete: true,
      organizationName: '測試研究室', organizationCode: 'TEST',
      supabaseUrl: 'https://test.supabase.co', anonKey: 'sb_publishable_test'
    });
  }
  if (target.includes('/api/profiles')) return respond({ profiles: REAL_PROFILES });
  if (target.includes('/api/data') && ((options && options.method) || 'GET') === 'GET') {
    return respond({ data: CURRENT_DATA, revision: 3 });
  }
  if (target.includes('/api/import')) {
    window.__importRequests.push(JSON.parse((options && options.body) || '{}'));
    return respond({ revision: 4, requestId: 'r1' });
  }
  return respond({});
};

// 不要用固定睡眠 —— 慢一點的機器上 change 事件還沒跑完就讀結果，
// 會得到「什麼都沒發生」的假失敗。改成輪詢到有反應為止。
async function waitFor(label, fn, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (fn()) return true; } catch (error) { /* 還沒好 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('等待逾時：' + label);
}

window.__run = (async () => {
  // 等頁面初始化完（loadProfiles + syncFromBackend）
  await waitFor('頁面初始化', () =>
    typeof backendEnabled === 'function' && backendEnabled() === true && window.appData);

  const input = document.getElementById('importJsonInput');
  const file = new File([IMPORT_TEXT], IMPORT_NAME, { type: 'application/json' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // 等匯入流程真的跑完：確認對話框出現、而且有匯入請求或被擋下的警告。
  await waitFor('匯入流程', () =>
    (window.__confirms.length > 0 || window.__alerts.length > 0)
    && (window.__importRequests.length > 0 || window.__alerts.length > 0));

  // 再讓後續的渲染與本機儲存寫入完成
  await new Promise(r => setTimeout(r, 400));

  const snapshotRaw = localStorage.getItem('LAB_TRACKER_LAST_IMPORT_SNAPSHOT');
  const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null;

  return {
    alerts: window.__alerts,
    confirms: window.__confirms,
    importRequests: window.__importRequests,
    hasSnapshot: !!snapshot,
    snapshotRowCount: snapshot ? (snapshot.data?.optBone || []).length : null,
    snapshotCaseId: snapshot ? (snapshot.data?.optBone || [])[0]?.id : null,
    // 匯入後的狀態
    rowCount: (window.appData?.optBone || []).length,
    musicCount: (window.appData?.music40 || []).length,
    studyCount: (window.appData?.customStudies || []).length,
    caseIds: (window.appData?.optBone || []).map(s => s.id),
    memberIds: (window.appData?.members || []).map(m => m.id),
    storageRowCount: (JSON.parse(localStorage.getItem(STORAGE) || '{}').optBone || []).length,
    errors: window.__uiErrors
  };
})();
</script>`;

  const reporter = `
<script>
window.__run.then(result => {
  const pre = document.createElement('pre');
  pre.id = 'import-result';
  pre.textContent = JSON.stringify(result, null, 2);
  document.body.appendChild(pre);
}).catch(error => {
  const pre = document.createElement('pre');
  pre.id = 'import-result';
  pre.textContent = JSON.stringify({ fatal: String(error && error.stack || error) });
  document.body.appendChild(pre);
});
</script>`;

  return html
    .replace('  <script>\n    const STORAGE_KEY', () => harness + '\n  <script>\n    const STORAGE_KEY')
    .replace('</body>', () => reporter + '\n</body>');
}

function runBrowser(payloadJson, fileName) {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, buildPage(payloadJson, fileName));
  try {
    const dom = execFileSync(CHROME, [
      '--headless=old', '--disable-gpu', '--no-sandbox',
      '--window-size=1440,1000', '--virtual-time-budget=90000',
      '--dump-dom', `file://${file}`
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = dom.match(/<pre id="import-result">([\s\S]*?)<\/pre>/);
    if (!match) return null;
    return JSON.parse(match[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 情境 1：使用者上傳的那份檔案（空的） ─────────────────────────────
console.log('\n【情境 1：把使用者上傳的那份檔案塞進匯入按鈕】');
const userRaw = readFileSync(USER_EXPORT, 'utf8');
const result1 = runBrowser(userRaw, 'zheng-lab-dashboard-backup-2026-11-25T15-55-35-694Z.json');

if (!result1) {
  console.log('✗ 頁面沒有回傳結果');
  failed += 1;
} else if (result1.fatal) {
  console.log(`✗ 頁面發生例外：${result1.fatal.split('\n')[0]}`);
  failed += 1;
} else {
  check('沒有跳出「格式不符」的警告',
    !result1.alerts.some(a => a.includes('格式不符')),
    result1.alerts.filter(a => a.includes('格式不符'))[0] || '');
  check('跳出了匯入確認對話框', result1.confirms.length >= 1,
    `${result1.confirms.length} 個`);
  check('確認對話框裡有摘要數字',
    result1.confirms.some(c => /OPT_Bone|music40|自訂研究案|成員/.test(c)),
    (result1.confirms[0] || '').split('\n').filter(Boolean).slice(0, 4).join(' / '));
  check('匯入前有存一份快照', result1.hasSnapshot === true);
  check('快照存的是匯入前的資料（舊個案）',
    result1.snapshotCaseId === 'OLD-01', `快照裡有 ${result1.snapshotRowCount} 筆`);
  check('真的有呼叫後端匯入 API', result1.importRequests.length === 1,
    `${result1.importRequests.length} 次`);
  check('送出的 requestId 是合法 UUID',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(result1.importRequests[0]?.requestId || ''));
  check('資料被換成檔案裡的內容（舊個案被取代）',
    result1.rowCount === 0 && !result1.caseIds.includes('OLD-01'),
    `個案 ${result1.rowCount} 筆：${JSON.stringify(result1.caseIds)}`);
  check('本機儲存也一起更新了', result1.storageRowCount === 0);
  check('名冊仍然是真的帳號（不是檔案裡的 admin）',
    result1.memberIds.length === 1 && result1.memberIds[0] === 'TEST',
    JSON.stringify(result1.memberIds));
  check('沒有 JavaScript 錯誤', result1.errors.length === 0,
    result1.errors.join(' / '));
}

// ── 情境 2：一份真的含資料的檔案 ─────────────────────────────────────
// 優先用 /tmp 那份「從線上系統實際按匯出」的檔案；找不到就自己造一份
// 同結構的（零依賴、可重現，不依賴執行環境的暫存檔）。
function buildRichExport() {
  const optBone = Array.from({ length: 12 }, (_, i) => ({
    id: `DEMO-0${i + 1}`,
    name: `示範個案 ${i + 1}`,
    group: 'OPT',
    status: '收案中',
    screenDate: '2099-10-01',
    baselineDate: '2099-10-05',
    t1Date: '2099-10-20', t1Owner: 'DEMO-A', t1Done: i % 2 === 0,
    p1Start: '2099-10-20', p1End: '2099-11-20', p1EndOwner: 'DEMO-B', p1EndDone: false,
    t2Date: '2099-11-25', t2Owner: 'DEMO-C', t2Done: false,
    fup1Date: '2099-12-01', fup1Done: false
  }));
  const music40 = Array.from({ length: 12 }, (_, i) => {
    const row = { id: `MUSIC-${i + 1}`, name: `音樂組個案 ${i + 1}`, startDate: '2099-09-01' };
    for (const stage of ['end', 'follow', 'eval1', 'quiz1', 'eval2', 'quiz2', 'eval3', 'quiz3']) {
      row[`${stage}Date`] = '2099-10-01';
      row[`${stage}Owner`] = 'DEMO-A';
      row[`${stage}Done`] = false;
    }
    return row;
  });
  const customStudies = [{
    code: 'DEMO-STUDY-001',
    description: '示範研究案',
    defaultOwner: 'DEMO-A',
    milestones: [
      { key: 'm0', label: '收案', offsetDays: 0, rule: 'manual', owner: 'DEMO-A' },
      { key: 'm1', label: '前測', offsetDays: 7, rule: 'manual', owner: 'DEMO-A' },
      { key: 'm2', label: '後測', offsetDays: 30, rule: 'manual', owner: 'DEMO-B' },
      { key: 'm3', label: '追蹤', offsetDays: 90, rule: 'manual', owner: 'DEMO-C' }
    ],
    subjects: [{
      id: 'DEMO-STUDY-001-S1', name: '示範受試者', startDate: '2099-09-15',
      items: {
        m0: { date: '2099-09-15', owner: 'DEMO-A', done: true },
        m1: { date: '2099-09-22', owner: 'DEMO-A', done: true },
        m2: { date: '', owner: 'DEMO-B', done: false },
        m3: { date: '', owner: 'DEMO-C', done: false }
      }
    }]
  }];
  return {
    schemaVersion: 1, refDate: '2099-10-24',
    members: ['DEMO-A', 'DEMO-B', 'DEMO-C', 'DEMO-D', 'DEMO-E']
      .map(code => ({ id: code, name: code, role: '示範成員' })),
    optBone, music40, customStudies,
    exportedAt: new Date('2099-10-24T00:00:00.000Z').toISOString()
  };
}

{
  const richRaw = existsSync(RICH_EXPORT)
    ? readFileSync(RICH_EXPORT, 'utf8')
    : JSON.stringify(buildRichExport(), null, 2);
  console.log(`\n【情境 2：真的含資料的匯出檔（12 筆 OPT + 12 筆 music40 + 1 研究案）】`);
  console.log(`  來源：${existsSync(RICH_EXPORT) ? RICH_EXPORT : '（自行產生）'}`);
  const richData = JSON.parse(richRaw);
  const result2 = runBrowser(richRaw, 'live-export.json');

  if (!result2) {
    console.log('✗ 頁面沒有回傳結果');
    failed += 1;
  } else if (result2.fatal) {
    console.log(`✗ 頁面發生例外：${result2.fatal.split('\n')[0]}`);
    failed += 1;
  } else {
    check('沒有跳出「格式不符」的警告',
      !result2.alerts.some(a => a.includes('格式不符')),
      result2.alerts.filter(a => a.includes('格式不符'))[0] || '');
    check('摘要裡有 12 筆 OPT_Bone',
      result2.confirms.some(c => /12/.test(c)),
      (result2.confirms[0] || '').split('\n').filter(Boolean).slice(0, 5).join(' / '));
    check('頁面上的個案變成 12 筆', result2.rowCount === 12, `${result2.rowCount} 筆`);
    check('music40 變成 12 筆', result2.musicCount === 12, `${result2.musicCount} 筆`);
    check('自訂研究案變成 1 案', result2.studyCount === 1, `${result2.studyCount} 案`);
    check('個案編號來自檔案，不是原有的',
      !result2.caseIds.includes('OLD-01') &&
      result2.caseIds.some(id => (richData.optBone || []).some(r => r.id === id)),
      JSON.stringify(result2.caseIds.slice(0, 4)));
    check('本機儲存也是 12 筆', result2.storageRowCount === 12, `${result2.storageRowCount} 筆`);
    check('名冊仍然是真帳號，沒被檔案的 DEMO 成員蓋掉',
      result2.memberIds.length === 1 && result2.memberIds[0] === 'TEST',
      JSON.stringify(result2.memberIds));
    check('沒有 JavaScript 錯誤', result2.errors.length === 0,
      result2.errors.join(' / '));
  }
}

console.log(`\n瀏覽器匯入按鈕測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
