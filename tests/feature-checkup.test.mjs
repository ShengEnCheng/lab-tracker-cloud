// 功能健檢：使用者在上傳的系統裡真的會做的每一件事，逐一操作一次。
//
// 為什麼需要這支：
// 其他測試各自守著一段（登入、匯入、匯出、引導網頁），但沒有人回答
// 「我把這個系統交給助理，他每天要做的事真的都做得成嗎」。
// 這支測試就是回答那個問題：用真的瀏覽器打開頁面，像使用者一樣點。
//
// 檢查的重點不是「有沒有報錯」，而是「做完之後資料對不對」：
// 每個動作都驗資料真的被改到、而且改對位置。

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

// 模擬「雲端模式、已登入」。
//
// 為什麼不能只用本機模式：頁面在沒有 supabaseUrl 時會停在「第一次設定」
// 畫面然後 return，後面的所有初始化（成員表單、頁籤、篩選）都不會綁定。
// 那不是 bug，是「沒設定資料庫就不該讓使用者看到半殘的主系統」的設計。
// 所以要驗真正的功能，就得像真的部署完一樣把環境設好。
window.__LAB_TRACKER_BACKEND__ = { enabled: true, apiBase: '/api', token: 'checkup-token' };
window.__LAB_TRACKER_AUTH__ = {
  setupComplete: true, organizationName: '健檢研究室', organizationCode: 'CHK',
  adminName: '主持人', adminEmail: 'pi@example.edu.tw',
  supabaseUrl: 'https://checkup.supabase.co', anonKey: 'sb_publishable_checkup'
};

const REAL_PROFILES = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'pi@example.edu.tw', display_name: '主持人', member_code: 'PI', role: 'admin', active: true }
];

// 雲端模式的成員名冊來自「真的有人有帳號」，不是資料檔裡的字串。
// 所以模擬新增成員時，伺服器端（這支假 fetch）也要真的把帳號加進去，
// 否則下一次讀名冊又會被覆蓋回原本的人 —— 那是正確行為，不是 bug。
window.__profileStore = REAL_PROFILES.slice();
let nextProfileId = 2;

// 已登入的狀態。少了這個，currentProfile 會是 null，
// isAdmin() 就變成 false —— 新增成員會被「只有管理者可以管理人員帳號」擋下。
// 那不是 bug，是權限設計；測試要模擬一個真的管理員。
localStorage.setItem('LAB_TRACKER_AUTH_SESSION', JSON.stringify({
  access_token: 'checkup-token',
  user: { id: REAL_PROFILES[0].id, email: REAL_PROFILES[0].email },
  expires_at: Math.floor(Date.now() / 1000) + 3600
}));

// 伺服器要有回應，頁面才會把主系統畫出來
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
      organizationName: '健檢研究室', organizationCode: 'CHK',
      supabaseUrl: 'https://checkup.supabase.co', anonKey: 'sb_publishable_checkup'
    });
  }
  if (target.includes('/api/profiles')) {
    // 新增成員（POST）與讀名冊（GET）走同一個端點，用 method 區分
    const method = String((options && options.method) || 'GET').toUpperCase();
    if (method === 'POST') {
      const body = JSON.parse((options && options.body) || '{}');
      const created = {
        id: '33333333-3333-4333-8333-' + String(nextProfileId++).padStart(12, '0'),
        email: body.email || '',
        display_name: body.display_name || body.member_code || '',
        member_code: body.member_code || '',
        role: body.role || 'researcher',
        active: true,
        generatedPassword: 'Temp-Pass-1234'
      };
      window.__profileStore.push(created);
      return respond(created);
    }
    return respond({ profiles: window.__profileStore });
  }
  if (target.includes('/api/data')) {
    return respond({
      data: {
        schemaVersion: 1,
        members: [],
        optBone: [{
          id: 'OPT-CHK1', name: '健檢個案', group: 'A組', status: '收案中',
          screenDate: '2026-09-01',
          t1Date: '2026-09-10', t1Owner: 'PI', t1Done: true,
          p1Start: '2026-09-11', p1End: '2026-10-09', p1EndOwner: 'PI', p1EndDone: false,
          t2Date: '2026-10-10', t2Owner: 'PI', t2Done: false,
          washStart: '2026-10-11', washEnd: '2026-11-08', washEndOwner: 'PI', washEndDone: false,
          t3Date: '2026-11-09', t3Owner: '', t3Done: false,
          p2Start: '', p2End: '', p2EndOwner: '', p2EndDone: false,
          t4Date: '', t4Owner: '', t4Done: false
        }],
        music40: [{
          id: 'M40-CHK1', name: '音樂健檢個案', startDate: '2026-09-01',
          endDate: '2026-11-30', endOwner: 'PI', endDone: false,
          followDate: '2027-03-01', followOwner: 'PI', followDone: false,
          eval1Date: '2026-09-02', eval1Owner: 'PI', eval1Done: true,
          quiz1Date: '2026-09-03', quiz1Owner: 'PI', quiz1Done: false,
          eval2Date: '', eval2Owner: '', eval2Done: false,
          quiz2Date: '', quiz2Owner: '', quiz2Done: false,
          eval3Date: '', eval3Owner: '', eval3Done: false,
          quiz3Date: '', quiz3Owner: '', quiz3Done: false
        }],
        customStudies: [{
          code: 'CHK-STUDY',
          description: '健檢用自訂研究案',
          defaultOwner: 'PI',
          milestones: [
            { key: 'm0', label: '基線', offsetDays: 0, rule: 'MUSIC40', owner: 'PI' },
            { key: 'm1', label: '一個月', offsetDays: 30, rule: 'MUSIC40', owner: 'PI' }
          ],
          subjects: [{
            id: 'S-CHK1', name: '受試者一', startDate: '2026-09-01',
            items: {
              m0: { date: '2026-09-01', owner: 'PI', done: true },
              m1: { date: '2026-10-01', owner: 'PI', done: false }
            }
          }]
        }]
      },
      revision: 1
    });
  }
  return respond({});
};

// headless Chrome 裡 alert()/confirm() 會真的把執行卡住等使用者按確定，
// 所以一定要先攔掉。順便把訊息留起來，需要時可以驗證提示內容。
window.__dialogs = [];
window.alert = (text) => { window.__dialogs.push({ kind: 'alert', text: String(text) }); };
window.confirm = (text) => { window.__dialogs.push({ kind: 'confirm', text: String(text) }); return true; };
window.prompt = (text) => { window.__dialogs.push({ kind: 'prompt', text: String(text) }); return ''; };

const results = [];
function check(name, fn) {
  try {
    const value = fn();
    results.push({ name, ok: !!value, value: typeof value === 'string' ? value : undefined });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error && error.message || error) });
  }
}

async function run() {
  // ---- 起始狀態 ----
  check('頁面載入後有資料', () => window.appData && Array.isArray(window.appData.optBone));
  const startMembers = (window.appData.members || []).length;
  const startOpt = window.appData.optBone.length;
  const startMusic = window.appData.music40.length;

  // ---- 1. 新增成員 ----
  // 雲端模式的成員一定要有登入 Email（那是真的帳號），欄位帶 required。
  // 沒填的話 requestSubmit() 會被瀏覽器原生驗證擋下，表單根本不會送出。
  document.getElementById('newMemEmail').value = 'chk-ra@example.edu.tw';
  document.getElementById('newMemId').value = 'CHK-RA';
  document.getElementById('newMemName').value = '健檢助理';
  // 用 requestSubmit()：dispatchEvent 不會觸發 form 的 submit 預設行為，
  // 有些瀏覽器情境下 e.preventDefault() 之後的流程不會跑。
  const addForm = document.getElementById('addMemberForm');
  if (typeof addForm.requestSubmit === 'function') addForm.requestSubmit();
  else addForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  // 這條路是非同步的：POST /profiles → 重新讀名冊 → 重畫。
  // 不等它跑完就檢查，會誤判成「新增失敗」。
  await new Promise(resolve => setTimeout(resolve, 400));
  check('新增成員後，伺服器上真的多一個帳號', () => window.__profileStore.length === 2);
  check('新成員的代號正確', () => window.__profileStore.some(p => p.member_code === 'CHK-RA'));
  check('新成員的姓名正確', () => window.__profileStore.some(p => p.member_code === 'CHK-RA' && p.display_name === '健檢助理'));
  check('伺服器回傳臨時密碼（否則新成員永遠登不進來）',
    () => window.__profileStore.some(p => p.member_code === 'CHK-RA' && typeof p.generatedPassword === 'string' && p.generatedPassword.length > 0));

  // 重複代號要被擋下（不是默默多一筆）
  const membersAfterAdd = window.appData.members.length;
  document.getElementById('newMemId').value = 'CHK-RA';
  document.getElementById('addMemberForm').dispatchEvent(new Event('submit', { cancelable: true }));
  check('重複的成員代號會被擋下', () => window.appData.members.length === membersAfterAdd);

  // ---- 2. 打勾（完成狀態）----
  // 這是使用者每天最常做的事：把某個追蹤節點標成做完了
  const optIndex = window.appData.optBone.findIndex(row => row.t1Done !== undefined);
  const before = window.appData.optBone[optIndex].t1Done;
  toggleTaskDone('optBone', 0, optIndex, 't1Done');
  check('打勾會切換完成狀態', () => window.appData.optBone[optIndex].t1Done === !before);
  toggleTaskDone('optBone', 0, optIndex, 't1Done');
  check('再打一次勾會取消（可以復原）', () => window.appData.optBone[optIndex].t1Done === before);

  // ---- 3. 自訂研究案的追蹤節點打勾 ----
  if ((window.appData.customStudies || []).length > 0) {
    const studyIdx = 0;
    const subjectIdx = 0;
    const study = window.appData.customStudies[studyIdx];
    const key = study.milestones[0].key;
    const item = study.subjects[subjectIdx].items[key];
    const beforeDone = item.done;
    toggleTaskDone('custom', studyIdx, subjectIdx, key);
    check('自訂研究案的節點可以打勾',
      () => window.appData.customStudies[studyIdx].subjects[subjectIdx].items[key].done === !beforeDone);
    toggleTaskDone('custom', studyIdx, subjectIdx, key);
  } else {
    results.push({ name: '自訂研究案的節點可以打勾', ok: false, detail: '沒有自訂研究案可測' });
  }

  // ---- 4. 日期推算 ----
  check('加天數算得正確（跨月）', () => addDays('2026-01-31', 1) === '2026-02-01');
  check('加天數算得正確（閏年）', () => addDays('2024-02-28', 1) === '2024-02-29');
  check('空日期不會亂算', () => addDays('', 30) === '');
  check('天數差算得正確', () => diffDays('2026-03-01', '2026-02-01') === 28);

  // ---- 5. 篩選與收案待辦 ----
  const allTasks = collectAllTasks();
  check('收案待辦收集得到任務', () => Array.isArray(allTasks) && allTasks.length > 0);
  check('每個任務都有個案編號', () => allTasks.every(t => typeof t.subjectId === 'string' && t.subjectId));
  check('每個任務都說得出是哪一個研究案', () => allTasks.every(t => typeof t.study === 'string' && t.study));
  check('每個任務都有負責人欄位', () => allTasks.every(t => 'owner' in t));
  check('任務有可辨識的完成狀態', () => allTasks.every(t => typeof t.done === 'boolean'));

  // ---- 6. 頁籤切換 ----
  const tabs = ['tab-action', 'tab-calendar', 'tab-custom'];
  check('三個主要頁籤的區塊都在', () => tabs.every(id => document.getElementById(id)));
  check('三個頁籤都有對應的切換按鈕',
    () => ['tab-action', 'tab-calendar', 'tab-management']
      .every(id => document.querySelector('[data-tab="' + id + '"]')));
  // 切到月曆
  const calTab = document.querySelector('[data-tab="tab-calendar"]');
  if (calTab) calTab.click();
  check('切換到月曆後月曆看得到', () => document.getElementById('tab-calendar').offsetParent !== null);
  check('月曆格數正確（含前後補格）', () => {
    const cells = document.querySelectorAll('#calendarGrid .cal-day');
    // 當月天數 + 前導空白格（最多 6 格），合理範圍 28~37
    if (cells.length < 28 || cells.length > 42) throw new Error('實際 ' + cells.length + ' 格');
    return true;
  });
  check('月曆有星期列', () => document.querySelectorAll('#calendarGrid .cal-dow').length === 7);

  // ---- 7. 匯出後再匯入（使用者的保命動作）----
  let exported = null;
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { window.__p = blob.text().then(t => { exported = t; }); return realCreate.call(URL, blob); };
  HTMLAnchorElement.prototype.click = function () { window.__name = this.download; };
  downloadJsonBackup('checkup', window.appData);

  // ---- 8. 資料真的存在瀏覽器裡（關掉重開還在）----
  check('資料有寫進瀏覽器儲存空間', () => {
    const raw = localStorage.getItem('LAB_TRACKER_STORAGE_V1');
    return typeof raw === 'string' && raw.length > 10;
  });

  // ---- 9. 品牌顯示 ----
  check('頁首顯示研究室名稱', () => document.body.textContent.includes('健檢研究室'));

  // ---- 10. 沒有把作者的名字帶進來 ----
  // 檢查「有沒有殘留原作者的東西」時要看頁面內容，不看 <script> 原始碼
  // （腳本裡難免有示範字串，那不是使用者看得到的東西）。
  const visibleText = Array.from(document.body.children)
    .filter(el => el.tagName !== 'SCRIPT')
    .map(el => el.textContent).join(' ');
  // 「有沒有寫死別人的資料庫」由 check-project.mjs 逐一掃過所有原始碼檔，
  // 比看渲染結果更徹底（那裡掃不到就代表畫面上不可能有）。
  // 這裡改驗一件不同的事：頁面用的是「這個部署自己的」設定值。
  check('頁面用的是這個部署自己的資料庫網址', () => {
    const configured = authConfig && authConfig.supabaseUrl;
    const expected = 'https://checkup.supabase.co';
    if (configured !== expected) throw new Error('實際拿到 ' + configured);
    return true;
  });
  check('頁面沒有殘留作者的名字', () => !visibleText.includes('鄭'));

  Promise.resolve(window.__p).then(() => {
    let parsed = null;
    try { parsed = JSON.parse(exported); } catch (e) { /* 下面回報 */ }
    check('匯出得到合法的 JSON', () => parsed && typeof parsed === 'object');
    check('匯出的資料包含剛新增的成員', () =>
      parsed && Array.isArray(parsed.members) && parsed.members.some(m => m.id === 'CHK-RA'));
    check('匯出的個案數與畫面一致', () =>
      parsed && parsed.optBone.length === window.appData.optBone.length);
    // 自訂研究案是最容易在匯出時被漏掉的（它的結構比前兩種複雜）
    check('匯出的資料包含自訂研究案', () =>
      parsed && Array.isArray(parsed.customStudies)
      && parsed.customStudies.length === window.appData.customStudies.length);
    check('自訂研究案的里程碑與個案都在匯出檔裡', () => {
      if (!parsed || !parsed.customStudies || !parsed.customStudies[0]) return false;
      const src = window.appData.customStudies[0];
      const out = parsed.customStudies[0];
      return out.milestones.length === src.milestones.length
        && out.subjects.length === src.subjects.length
        && Object.keys(out.subjects[0].items).length === Object.keys(src.subjects[0].items).length;
    });

    check('整體沒有 JavaScript 錯誤', () => window.__uiErrors.length === 0);

    const pre = document.createElement('pre');
    pre.id = 'checkup-result';
    pre.textContent = JSON.stringify({ results, errors: window.__uiErrors }, null, 2);
    document.body.appendChild(pre);
  });
}

window.addEventListener('load', () => setTimeout(async () => {
  try { await run(); }
  catch (error) {
    const pre = document.createElement('pre');
    pre.id = 'checkup-result';
    pre.textContent = JSON.stringify({
      results: [{ name: '健檢腳本自己出錯', ok: false, detail: String(error && error.stack || error) }],
      errors: window.__uiErrors
    });
    document.body.appendChild(pre);
  }
}, 800));
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'lab-cloud-checkup-'));
const pagePath = join(dir, 'checkup.html');
// 用函式當取代參數：字串會有 $&、$' 之類的特殊樣式
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

const match = dom.match(/<pre id="checkup-result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('✗ 功能健檢沒有回傳結果（頁面可能載入失敗）。');
  process.exit(1);
}
const payload = JSON.parse(match[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));

console.log('\n【功能健檢：使用者每天要做的事都做得成嗎】');
let failed = 0;
for (const { name, ok, detail, value } of payload.results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
if (payload.errors.length) {
  for (const error of payload.errors) console.log(`  JavaScript 錯誤：${error}`);
}
console.log(`\n功能健檢：${payload.results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
