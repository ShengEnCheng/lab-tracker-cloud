// 雲端模式下的成員名冊：匯入別人的備份之後，名冊必須還是「真正能登入的人」。
//
// 為什麼要單獨測這件事：
// 匯入的 JSON 檔裡帶著「匯出那套系統」的成員名冊。使用者從 DEMO 系統
// 匯出資料、匯入自己的新系統時，新系統的名冊會被 DEMO 的名冊蓋掉——
// 於是畫面顯示「DEMO-A / DEMO-B」這些根本沒有帳號、也登不進來的人，
// 而真正的管理員反而從名冊上消失。
//
// 這支測試用真的 Chrome 開 index.html，模擬「雲端模式、已登入」，
// 然後餵一份帶著外來成員名冊的資料，確認名冊最後是對的。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = readFileSync('index.html', 'utf8');

// 真正能登入的人（來自 /api/profiles）
const REAL_PROFILES = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'pi@example.edu.tw', display_name: '鄭老師', member_code: 'PI', role: 'admin', active: true },
  { id: '22222222-2222-4222-8222-222222222222', email: 'ra@example.edu.tw', display_name: '助理一', member_code: 'RA1', role: 'researcher', active: true }
];

// 匯入檔裡帶的「外來名冊」——這些人在這套系統裡沒有帳號
const FOREIGN_MEMBERS = [
  { id: 'DEMO-A', code: 'DEMO-A', name: 'DEMO-A（同學）', role: '示範成員' },
  { id: 'DEMO-B', code: 'DEMO-B', name: 'DEMO-B（同學）', role: '示範成員' }
];

const harness = `
<script>
window.__uiErrors = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

const REAL_PROFILES = ${JSON.stringify(REAL_PROFILES)};
const FOREIGN_MEMBERS = ${JSON.stringify(FOREIGN_MEMBERS)};

// 這份資料模擬「從 DEMO 匯出的檔案」：資料是新的，但 members 是外來名冊
const IMPORTED_DATA = {
  schemaVersion: 1,
  members: FOREIGN_MEMBERS,
  optBone: [
    { id: 'OPT-001', name: '王小明', owner: 'PI', study: 'OPT', status: '收案中', baselineDate: '2026-09-01', fup1Done: true, t1Owner: 'DEMO-OWNER' }
  ],
  music40: [],
  customStudies: []
};

// 雲端模式：假裝已經登入、有 token
window.__LAB_TRACKER_BACKEND__ = { enabled: true, apiBase: '/api', token: 'test-token' };
window.__LAB_TRACKER_AUTH__ = {
  setupComplete: true,
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  supabaseUrl: 'https://test.supabase.co',
  anonKey: 'sb_publishable_test'
};
localStorage.setItem('LAB_TRACKER_AUTH_SESSION', JSON.stringify({
  access_token: 'test-token',
  user: { id: REAL_PROFILES[0].id, email: REAL_PROFILES[0].email },
  expires_at: Math.floor(Date.now() / 1000) + 3600
}));

window.fetch = async (url, options) => {
  const target = String(url);
  const respond = (body, status = 200) => ({
    ok: status < 400, status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  if (target.includes('/api/config')) {
    return respond({
      app: '研究室追蹤系統', version: '1.0.0',
      backendConfigured: true, setupComplete: true,
      organizationName: '認知神經科學研究室', organizationCode: 'CNC',
      supabaseUrl: 'https://test.supabase.co', anonKey: 'sb_publishable_test'
    });
  }
  if (target.includes('/api/profiles')) return respond({ profiles: REAL_PROFILES });
  if (target.includes('/api/data')) return respond({ data: IMPORTED_DATA, revision: 5 });
  if (target.includes('/api/import')) return respond({ revision: 6, requestId: 'r1' });
  return respond({});
};

function report() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };

  // 讓非同步的同步流程跑完（loadProfiles → syncFromBackend）
  setTimeout(() => {
    const members = window.appData ? window.appData.members : null;

    // 名冊只能有真正能登入的人
    check('名冊沒有出現外來的示範成員', () =>
      !(members || []).some(m => String(m.id).startsWith('DEMO')));

    check('名冊裡有真正的管理員', () =>
      (members || []).some(m => m.id === 'PI'));

    check('名冊人數等於真正有帳號的人數', () =>
      (members || []).length === REAL_PROFILES.length);

    check('名冊代號用的是 member_code', () =>
      (members || []).every(m => ['PI', 'RA1'].includes(m.id)));

    // 資料本身要保留（不能因為校正名冊把個案弄丟）
    check('匯入的個案還在', () =>
      (window.appData?.optBone || []).some(s => s.id === 'OPT-001'));

    // 這項是「測試自己有沒有測到東西」的守門員：
    // 如果後端模式根本沒開起來，下面的斷言會全部在測一個假的情境。
    check('後端模式真的有開起來（否則這個測試沒在測東西）', () => backendEnabled() === true);
    check('管理員代號讀得到', () => currentMemberCode() === 'PI');
    // 匯入的資料裡，負責人代號是舊系統的人（DEMO-A）。
    // 資料要原樣保留（那是歷史紀錄），但程式要認得出「這些不是成員」，
    // 才能在使用者匯入後提醒他，而不是讓他以為名冊壞了。
    check('認得出不屬於名冊的負責人代號', () => {
      const unknown = findUnknownOwners();
      return Array.isArray(unknown) && unknown.includes('DEMO-OWNER');
    });
    check('自己的成員代號不會被當成外來', () => !findUnknownOwners().includes('PI'));

    // 匯入摘要會直接顯示在對話框裡。曾經這裡的換行寫成「兩個反斜線 + n」，
    // 結果使用者看到的是字面上的反斜線加 n，而不是換行，整個摘要擠成一長串。
    // 這是使用者一定會看到的畫面，所以固定驗一次。
    check('匯入摘要用的是真正的換行，不是字面上的反斜線 n', () => {
      const text = summarizeImportedData(IMPORTED_DATA, 'demo.json');
      // 用字元碼判斷，避免這支測試自己的樣板字串又把它轉義掉
      const REAL_NEWLINE = String.fromCharCode(10);
      const LITERAL_BACKSLASH_N = String.fromCharCode(92, 110);
      return text.includes(REAL_NEWLINE) && !text.includes(LITERAL_BACKSLASH_N);
    });

    check('未捕捉到 JavaScript 錯誤', () => window.__uiErrors.length === 0);

    const pre = document.createElement('pre');
    pre.id = 'roster-result';
    pre.textContent = JSON.stringify({
      results, errors: window.__uiErrors,
      members: (members || []).map(m => m.id)
    }, null, 2);
    document.body.appendChild(pre);
  }, 1200);
}
window.addEventListener('load', () => setTimeout(report, 600));
</script>`;

// index.html 用 var appData 宣告，所以可以從 window 讀到
const dir = mkdtempSync(join(tmpdir(), 'lab-cloud-roster-'));
const pagePath = join(dir, 'roster-test.html');
writeFileSync(pagePath, html.replace('</body>', harness + '\n</body>'));

let dom;
try {
  dom = execFileSync(CHROME, [
    '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
    '--virtual-time-budget=20000', '--dump-dom', `file://${pagePath}`
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const match = dom.match(/<pre id="roster-result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('✗ 成員名冊測試沒有回傳結果（頁面可能載入失敗）。');
  process.exit(1);
}
const payload = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

console.log('\n【雲端模式的成員名冊：不能被外來備份蓋掉】');
let failed = 0;
for (const { name, ok, detail } of payload.results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
console.log(`（最後的名冊：${(payload.members || []).join('、') || '空'}）`);
if (payload.errors.length) {
  for (const error of payload.errors) console.log(`  JavaScript 錯誤：${error}`);
}
console.log(`\n成員名冊測試：${payload.results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
