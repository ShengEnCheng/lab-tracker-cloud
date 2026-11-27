// 資料安全測試：登入不要無聲蓋掉「還沒同步的本機資料」。
//
// 這支測試守的是一個**已經發生過的真實事故**。
//
// 這套系統允許「沒登入也能作業」：資料庫還沒接好、或助理趕時間先打了幾筆，
// 畫面照樣能用，資料只存在這台電腦的瀏覽器裡。而「登入」這個動作會把共用
// 資料庫的內容整份拉下來覆蓋本機 —— 如果中間不問一聲，助理剛剛打的一整天
// 就這樣沒了，而且完全沒有訊息，他只會覺得「怎麼資料變成同事的了」。
//
// 前身專案 zheng-lab-tracker 踩過這個坑並修掉；cloud 版在改寫時漏掉了這段。
// 這支測試就是為了不讓它再漏一次。
//
// 做法：用真的 Chrome 開 index.html，注入 harness 模擬「已登入 + 本機有資料」，
// 再呼叫 syncFromBackend() 看本機資料還在不在。confirm() 一定要換掉 ——
// headless Chrome 的 confirm 會讓頁面卡死（真的卡過一次，60 秒 timeout）。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = readFileSync('index.html', 'utf8');

function buildHarness({ confirmAnswer, remoteData, localSubjects, skipAuth }) {
  return `
<script>
window.__probe = {};
window.addEventListener('error', e => (window.__probe.errors = window.__probe.errors || []).push(String(e.message)));
window.addEventListener('unhandledrejection', e => (window.__probe.errors = window.__probe.errors || []).push('rej:' + String(e.reason)));

// headless Chrome 的 confirm() 會阻塞事件迴圈，整頁卡死到 timeout。
// 一定要換掉，而且要記錄「有沒有被問」—— 那正是我們要驗的行為。
window.__confirmCalls = 0;
window.confirm = () => { window.__confirmCalls += 1; return ${confirmAnswer}; };
window.alert = () => {};

localStorage.clear();
const realFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.includes('/api/config')) return json({
    supabaseUrl: 'https://fake.supabase.co', anonKey: 'fake-anon',
    setupComplete: true, organizationName: '測試研究室', organizationCode: 'T'
  });
  if (u.includes('/api/profiles') || u.includes('lab_profiles')) return json({ profiles: [
    { id: 'u1', email: 'a@b.c', display_name: 'A', role: 'researcher', active: true, member_code: 'M1' }
  ] });
  if (u.includes('/api/data')) {
    if (opts && opts.method === 'POST') return json({ revision: 8 });
    return json({ data: ${JSON.stringify(remoteData)}, revision: 7 });
  }
  if (u.includes('/auth/v1') || u.includes('token')) return json({
    access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'u1', email: 'a@b.c' }
  });
  return realFetch(url, opts);
};

const subjectsOf = () => (appData.customStudies || []).flatMap(s => s.subjects || []).map(x => x.id);

window.addEventListener('load', async () => {
  await new Promise(r => setTimeout(r, 800));
  if (!${skipAuth ? 'true' : 'false'}) {
    setAuthSession({ access_token: 'tok', refresh_token: 'ref', user: { id: 'u1', email: 'a@b.c' } });
  }
  appData.customStudies = [{ id: 's-local', name: '本機研究', subjects: ${JSON.stringify(localSubjects)} }];
  saveData();

  // 真實的登入流程是 loadProfiles() → syncFromBackend()（見 index.html 的登入處理）。
  // 少了 loadProfiles，currentProfile 是 null，「待上傳」狀態就永遠不會出現 ——
  // 那不是程式的問題，是 harness 沒有照真實流程走。
  await loadProfiles();

  window.__probe.beforeSync = subjectsOf();
  window.__probe.kindBefore = dataStateKind();
  window.__probe.syncReturned = await syncFromBackend();
  window.__probe.afterSync = subjectsOf();
  window.__probe.pendingLocalUpload = pendingLocalUpload;
  window.__probe.kindAfter = dataStateKind();
  window.__probe.confirmCalls = window.__confirmCalls;

  document.title = 'PROBE:' + JSON.stringify(window.__probe);
});
</script>`;
}

const REMOTE_WITH_DATA = {
  refDate: '2026-01-01', members: [], optBone: [], music40: [],
  customStudies: [{ id: 's9', name: '遠端研究', subjects: [{ id: 'REMOTE-1' }] }]
};

const REMOTE_EMPTY = {
  refDate: '2026-01-01', members: [], optBone: [], music40: [], customStudies: []
};

function run(label, options) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-cloud-safety-'));
  const pagePath = join(dir, 'safety.html');
  writeFileSync(pagePath, html.replace('</body>', buildHarness(options) + '\n</body>'));
  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
      '--virtual-time-budget=8000', '--dump-dom', `file://${pagePath}`
    ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const match = dom.match(/<title>PROBE:(.*?)<\/title>/s);
  if (!match) {
    console.error(`✗ [${label}] 頁面沒有完成載入`);
    return null;
  }
  const raw = match[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`✗ [${label}] 讀不回探測結果：${raw.slice(0, 200)}`);
    return null;
  }
}

const results = [];
function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    ok = Boolean(fn());
  } catch (error) {
    detail = String((error && error.message) || error);
  }
  results.push({ name, ok, detail });
}

// ---------------------------------------------------------------------------
// 情境 1：兩邊都有資料 → 必須問使用者
// ---------------------------------------------------------------------------
console.log('【情境 1：本機有資料，共用資料庫也有 → 要問】');
const asked = run('兩邊都有資料', {
  confirmAnswer: 'false',           // 使用者按「取消」= 保留本機
  remoteData: REMOTE_WITH_DATA,
  localSubjects: [{ id: 'LOCAL-1' }]
});

check('本機資料在同步前存在', () => asked && asked.beforeSync.includes('LOCAL-1'));
check('有問使用者要不要覆蓋（不是無聲蓋掉）', () => asked && asked.confirmCalls >= 1);
check('使用者按「取消」後，本機資料還在', () => asked && asked.afterSync.includes('LOCAL-1'));
check('按「取消」後沒有把遠端資料套進來', () => asked && !asked.afterSync.includes('REMOTE-1'));
check('按「取消」時 syncFromBackend 回報「沒有同步成功」', () => asked && asked.syncReturned === false);
check('沒有 JavaScript 錯誤', () => asked && !(asked.errors && asked.errors.length));

// ---------------------------------------------------------------------------
// 情境 2：使用者同意覆蓋 → 真的要蓋掉
//   只驗「有問」不夠：問了卻不管答案，等於沒問。
// ---------------------------------------------------------------------------
console.log('\n【情境 2：本機有資料，使用者同意覆蓋 → 要照做】');
const agreed = run('同意覆蓋', {
  confirmAnswer: 'true',
  remoteData: REMOTE_WITH_DATA,
  localSubjects: [{ id: 'LOCAL-1' }]
});

check('有問使用者', () => agreed && agreed.confirmCalls >= 1);
check('按「確定」後真的套用遠端資料', () => agreed && agreed.afterSync.includes('REMOTE-1'));
check('按「確定」後本機資料被覆蓋（符合使用者期待）', () => agreed && !agreed.afterSync.includes('LOCAL-1'));

// ---------------------------------------------------------------------------
// 情境 3：共用資料庫是空的，這台電腦卻有資料
//   這是最危險的情況：遠端空白看起來「沒有東西可以失去」，
//   但覆蓋下去等於把使用者唯一的一份資料刪掉。這種絕對不能蓋，也不必問。
// ---------------------------------------------------------------------------
console.log('\n【情境 3：共用資料庫是空的、本機有資料 → 一定要保留】');
const remoteEmpty = run('遠端空白', {
  confirmAnswer: 'true',            // 就算使用者亂按「確定」也不能蓋
  remoteData: REMOTE_EMPTY,
  localSubjects: [{ id: 'LOCAL-1' }]
});

check('本機資料還在（遠端空白時絕不能蓋）', () => remoteEmpty && remoteEmpty.afterSync.includes('LOCAL-1'));
check('標記成「待上傳」，讓使用者知道要自己存上去', () => remoteEmpty && remoteEmpty.pendingLocalUpload === true);
check('狀態變成 pending-upload（畫面上看得出來）', () => remoteEmpty && remoteEmpty.kindAfter === 'pending-upload');
check('這種情況不必問（答案只有一個）', () => remoteEmpty && remoteEmpty.confirmCalls === 0);

// ---------------------------------------------------------------------------
// 情境 4：本機只有系統內建的示範資料 → 不必問，直接蓋
//   問了反而讓人困惑（「我哪有什麼資料？」），而且示範資料本來就沒有價值。
// ---------------------------------------------------------------------------
console.log('\n【情境 4：本機只有示範資料 → 不必問，直接覆蓋】');
const demo = run('示範資料', {
  confirmAnswer: 'false',
  remoteData: REMOTE_WITH_DATA,
  localSubjects: [
    { id: 'DEMO-01', name: 'DEMO-001', baselineDate: '2099-10-24' },
    { id: 'DEMO-02', name: 'DEMO-002', baselineDate: '2099-10-24' }
  ]
});

check('示範資料不必問（不該打擾使用者）', () => demo && demo.confirmCalls === 0);
check('示範資料直接被遠端資料取代', () => demo && demo.afterSync.includes('REMOTE-1'));

// ---------------------------------------------------------------------------
// 情境 5：資料狀態橫幅
//   光有 confirm 不夠：使用者要在「還沒登入、資料只在本機」時就看得出來，
//   而不是等到登入那一刻才被問。
// ---------------------------------------------------------------------------
console.log('\n【情境 5：畫面要能看出「資料只在這台電腦」】');
check('未登入且本機有真資料時，狀態是 local-only', () => {
  const probe = run('未登入', {
    confirmAnswer: 'true',
    remoteData: REMOTE_WITH_DATA,
    localSubjects: [{ id: 'LOCAL-9' }],
    // 不呼叫 setAuthSession 就是「沒登入」
    skipAuth: true
  });
  return probe && probe.kindBefore === 'local-only';
});

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
for (const { name, ok, detail } of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
console.log(`\n資料安全測試：${results.length - failed.length} 通過，${failed.length} 失敗`);
process.exit(failed.length ? 1 : 0);
