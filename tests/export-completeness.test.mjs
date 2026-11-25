// 匯出完整性：系統裡的每一種資料，匯出後都要一字不差。
//
// 為什麼要單獨測這件事：
// 「匯出」看起來很簡單（就是 JSON.stringify），但它其實是使用者唯一的
// 保命手段——研究室搬家、換系統、資料庫出事，靠的都是這份檔案。
// 只要有一個欄位沒被寫進去，那個欄位就是永久消失，而且不會有任何錯誤訊息。
//
// 這支測試的做法：
//   1. 造一份「每一個欄位都填了可辨識的值」的資料
//   2. 用頁面裡真正的 downloadJsonBackup() 匯出（不是自己抄一份邏輯）
//   3. 把匯出的內容再餵回真正的匯入流程
//   4. 逐欄位比對，確認一個都沒少、一個都沒被改
//
// 這比「跑起來沒報錯」嚴格得多：漏掉欄位不會報錯，只會安靜地少資料。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = readFileSync('index.html', 'utf8');

const harness = `
<script>
window.__uiErrors = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

// 本機模式（沒有後端）：單純驗「資料進得去、出得來」。
// 雲端模式的成員名冊另有規則，由 roster.test.mjs 負責。
window.__LAB_TRACKER_AUTH__ = { setupComplete: true, organizationName: '匯出測試室', organizationCode: 'EXP' };

// 一份「每個欄位都不一樣」的資料。刻意讓每個值都可辨識，
// 這樣任何欄位被漏掉或對調，比對時都會看得出來。
const FULL_STATE = {
  schemaVersion: 7,
  members: [
    { id: 'PI', code: 'PI', name: '主持人', role: 'admin' },
    { id: 'RA1', code: 'RA1', name: '助理一', role: 'researcher' }
  ],
  optBone: [
    {
      id: 'OPT-A1', name: '個案甲', group: '實驗組', status: '收案中',
      screenDate: '2026-01-11',
      t1Date: '2026-02-11', t1Owner: 'PI', t1Done: true,
      p1Start: '2026-02-12', p1End: '2026-03-11', p1EndOwner: 'RA1', p1EndDone: true,
      t2Date: '2026-03-12', t2Owner: 'PI', t2Done: false,
      washStart: '2026-03-13', washEnd: '2026-04-11', washEndOwner: 'RA1', washEndDone: false,
      t3Date: '2026-04-12', t3Owner: 'PI', t3Done: false,
      p2Start: '2026-04-13', p2End: '2026-05-11', p2EndOwner: 'RA1', p2EndDone: false,
      t4Date: '2026-05-12', t4Owner: 'PI', t4Done: false,
      baselineDate: '2026-01-11', fup1Date: '2026-02-11', fup1Done: true
    }
  ],
  music40: [
    {
      id: 'M40-A1', name: '音樂個案甲', startDate: '2026-01-15',
      endDate: '2026-04-15', endOwner: 'PI', endDone: false,
      followDate: '2026-07-15', followOwner: 'RA1', followDone: false,
      eval1Date: '2026-01-16', eval1Owner: 'PI', eval1Done: true,
      quiz1Date: '2026-01-17', quiz1Owner: 'RA1', quiz1Done: true,
      eval2Date: '2026-02-16', eval2Owner: 'PI', eval2Done: false,
      quiz2Date: '2026-02-17', quiz2Owner: 'RA1', quiz2Done: false,
      eval3Date: '2026-03-16', eval3Owner: 'PI', eval3Done: false,
      quiz3Date: '2026-03-17', quiz3Owner: 'RA1', quiz3Done: false
    }
  ],
  customStudies: [
    {
      code: 'MY-STUDY',
      description: '自訂研究案說明',
      defaultOwner: 'PI',
      milestones: [
        { key: 'm0', label: '基線', offsetDays: 0, rule: 'MUSIC40', owner: 'PI' },
        { key: 'm1', label: '一個月', offsetDays: 30, rule: 'MUSIC40', owner: 'RA1' }
      ],
      subjects: [
        {
          id: 'S-01', name: '受試者一', startDate: '2026-02-01',
          items: {
            m0: { date: '2026-02-01', owner: 'PI', done: true },
            m1: { date: '2026-03-03', owner: 'RA1', done: false }
          }
        }
      ]
    }
  ]
};

// 把「匯出的內容」抓下來：downloadJsonBackup 用 Blob + a.click()，
// 這裡攔住那兩個地方，取得真正的檔案內容。
let capturedExport = null;
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  // 非同步把 Blob 讀成文字（測試在後面的步驟會等它）
  window.__capturePromise = blob.text().then(text => { capturedExport = text; });
  return realCreateObjectURL.call(URL, blob);
};
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  window.__downloadName = this.download || '';
  // 不真的下載，只記錄檔名
};

function report() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };

  const finish = () => {
    let exported = null;
    try { exported = JSON.parse(capturedExport); } catch (e) { /* 下面會回報 */ }

    // --- 1. 匯出檔本身 ---
    check('匯出成功，拿到一個 JSON 檔', () => exported && typeof exported === 'object');
    check('檔名看得出是什麼時候匯出的', () => /^lab-tracker-dashboard-backup-.*\\.json$/.test(window.__downloadName || ''));
    check('匯出檔有 schemaVersion', () => exported && typeof exported.schemaVersion === 'number');
    check('匯出檔有 exportedAt', () => exported && typeof exported.exportedAt === 'string');

    // --- 2. 逐欄位比對：匯出的內容要跟記憶體裡的一模一樣 ---
    const strip = (obj) => {
      const copy = JSON.parse(JSON.stringify(obj));
      delete copy.schemaVersion;
      delete copy.exportedAt;
      delete copy.refDate;   // 檢視用的當天日期，本來就不存進資料
      return copy;
    };
    const before = strip(FULL_STATE);
    const after = exported ? strip(exported) : {};

    check('成員名冊完整匯出', () =>
      JSON.stringify(after.members) === JSON.stringify(before.members));
    check('OPT_Bone 個案完整匯出（含所有日期、負責人、完成狀態）', () =>
      JSON.stringify(after.optBone) === JSON.stringify(before.optBone));
    check('music40 個案完整匯出（含 eval/quiz 全部欄位）', () =>
      JSON.stringify(after.music40) === JSON.stringify(before.music40));
    check('自訂研究案完整匯出（含里程碑與個案追蹤節點）', () =>
      JSON.stringify(after.customStudies) === JSON.stringify(before.customStudies));

    // 逐個欄位點名，這樣漏掉時訊息會指出是哪一個
    const missing = [];
    const walk = (expected, actual, path) => {
      if (expected === null || typeof expected !== 'object') {
        if (JSON.stringify(expected) !== JSON.stringify(actual)) missing.push(path);
        return;
      }
      if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) { missing.push(path + '[]'); return; }
        expected.forEach((item, i) => walk(item, actual[i], path + '[' + i + ']'));
        return;
      }
      for (const key of Object.keys(expected)) {
        if (!(key in (actual || {}))) { missing.push(path + '.' + key); continue; }
        walk(expected[key], actual[key], path + '.' + key);
      }
    };
    walk(before, after, '$');

    check('沒有任何欄位在匯出時消失或變值', () => missing.length === 0);
    if (missing.length) results.push({ name: '缺少的欄位（前 12 個）', ok: false, detail: missing.slice(0, 12).join(', ') });

    // --- 3. 匯入：把剛才匯出的內容餵回真正的匯入流程 ---
    check('匯出的檔案可以通過資料格式檢查', () => {
      const errors = validateImportedData(exported);
      if (errors.length) throw new Error(errors.join('; '));
      return true;
    });

    // 匯入後再匯出一次，兩份要一樣（round-trip 穩定，不會每匯一次就變形）
    const secondRound = JSON.parse(JSON.stringify(exported));
    const a = JSON.stringify(strip(exported));
    const b = JSON.stringify(strip(secondRound));
    check('同一份資料再匯出一次，結果完全相同（不會愈匯愈走樣）', () => a === b);

    // --- 4. 統計數字要對得上（使用者用摘要判斷資料對不對） ---
    const summary = summarizeImportedData(exported, 'backup.json');
    check('摘要算得出個案數', () => summary.includes('OPT_Bone 個案：1'));
    check('摘要算得出 music40 個案數', () => summary.includes('music40 個案：1'));
    check('摘要算得出自訂研究案與追蹤節點', () =>
      summary.includes('自訂研究案：1') && summary.includes('追蹤節點：2'));
    check('摘要算得出已完成項目數', () => /已完成項目：約 \\d+ 筆/.test(summary));

    check('未捕捉到 JavaScript 錯誤', () => window.__uiErrors.length === 0);

    const pre = document.createElement('pre');
    pre.id = 'export-result';
    pre.textContent = JSON.stringify({
      results, errors: window.__uiErrors,
      missing: missing.slice(0, 20),
      exportName: window.__downloadName
    }, null, 2);
    document.body.appendChild(pre);
  };

  // 先讓下載流程跑起來，再等 Blob 讀完
  try {
    window.appData = JSON.parse(JSON.stringify(FULL_STATE));
    window.appData.refDate = getTodayISO();
    downloadJsonBackup('dashboard-backup', window.appData);
  } catch (error) {
    results.push({ name: '呼叫匯出時出錯', ok: false, detail: String(error && error.message || error) });
  }
  // finish() 裡任何一步出錯都要留下痕跡，否則這支測試會「安靜地沒有結果」，
  // 看起來像「頁面載入失敗」，實際上是我自己的比對程式碼有 bug。
  const fail = (error) => {
    const pre = document.createElement('pre');
    pre.id = 'export-result';
    pre.textContent = JSON.stringify({
      results: [{ name: '匯出測試腳本自己出錯', ok: false, detail: String(error && error.stack || error) }],
      errors: window.__uiErrors, missing: []
    });
    document.body.appendChild(pre);
  };
  Promise.resolve(window.__capturePromise)
    .then(() => { try { finish(); } catch (error) { fail(error); } })
    .catch(error => {
      results.push({ name: '讀取匯出內容失敗', ok: false, detail: String(error) });
      try { finish(); } catch (inner) { fail(inner); }
    });
}

window.addEventListener('load', () => setTimeout(() => {
  try { report(); }
  catch (error) {
    const pre = document.createElement('pre');
    pre.id = 'export-result';
    pre.textContent = JSON.stringify({ results: [{ name: '測試腳本自己出錯', ok: false, detail: String(error && error.stack || error) }], errors: window.__uiErrors, missing: [] });
    document.body.appendChild(pre);
  }
}, 700));
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'lab-cloud-export-'));
const pagePath = join(dir, 'export-test.html');
// 用「函式」當第二個參數，不要用字串：
// String.replace 會把取代字串裡的 $&、$'、$` 當成特殊樣式。
// harness 裡有 path 用的 '$' 字面值，用字串的話 $' 會被換成「比對位置之後的全部 HTML」，
// 把頁面尾部整段塞進我的 JavaScript 中間 —— 變成語法錯誤，而且錯誤訊息完全看不出原因。
writeFileSync(pagePath, html.replace('</body>', () => harness + '\n</body>'));

let dom;
try {
  dom = execFileSync(CHROME, [
    '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
    '--virtual-time-budget=20000', '--dump-dom', `file://${pagePath}`
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const match = dom.match(/<pre id="export-result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('✗ 匯出完整性測試沒有回傳結果（頁面可能載入失敗）。');
  process.exit(1);
}
const raw = match[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const payload = JSON.parse(raw);

console.log('\n【匯出完整性：每一種資料、每一個欄位都要在】');
let failed = 0;
for (const { name, ok, detail } of payload.results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
if (payload.missing && payload.missing.length) {
  console.log(`\n缺少的欄位：${payload.missing.join(', ')}`);
}
if (payload.errors.length) {
  for (const error of payload.errors) console.log(`  JavaScript 錯誤：${error}`);
}
console.log(`\n匯出完整性測試：${payload.results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
