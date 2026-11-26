// UI 測試：用真正的 Chrome 載入頁面，檢查使用者實際會看到什麼。
//
// 這個專案的 UI 有兩種截然不同的狀態：
//   1. 還沒設定 → 看到「第一次設定」畫面
//   2. 設定完成 → 看到正常的主系統
// 兩種都要測，因為第一種如果壞了，助理根本無法開始使用。
//
// 做法與原本的 zheng-lab-tracker 相同：把測試腳本注入 HTML 再跑，
// 但用 --dump-dom 取回結果，不需要 puppeteer 之類的套件。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = readFileSync('index.html', 'utf8');

// ---------------------------------------------------------------------------
// 情境 A：還沒設定（沒有後端設定時的正常畫面）
// ---------------------------------------------------------------------------
const harnessSetup = `
<script>
window.__uiErrors = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

// 攔截 /api/config 讓它回「還沒設定」，模擬全新部署
window.fetch = async (url) => {
  if (String(url).includes('/api/config')) {
    return {
      ok: true,
      json: async () => ({
        app: 'lab-tracker-cloud',
        version: '1.0.0',
        backendConfigured: false,
        setupComplete: false,
        organizationName: '',
        supabaseUrl: '',
        anonKey: ''
      })
    };
  }
  return { ok: false, json: async () => ({}) };
};

function report() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };
  const $ = id => document.getElementById(id);
  const visible = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none';

  // --- 設定畫面要出現 ---
  check('顯示第一次設定畫面', () => visible($('setupGate')));
  check('主系統被藏起來（不該看到半殘畫面）', () => document.body.classList.contains('setup-pending'));
  check('有標題「歡迎使用研究室追蹤系統」', () => document.querySelector('.setup-title')?.textContent.includes('歡迎使用'));
  check('沒有後端時不顯示填了也沒用的表單', () => !visible($('setupForm')));

  // --- 顯示「還不能開始」的指引，而不是丟錯誤 ---
  check('顯示環境未設定的說明', () => visible($('setupBlocked')));
  check('說明文字有提到資料庫', () => ($('setupBlockedMessage')?.textContent || '').includes('資料庫'));
  check('給了具體的解決步驟', () => document.querySelectorAll('#setupBlockedSteps li').length >= 3);
  check('步驟有提到 Vercel 環境變數', () => ($('setupBlockedSteps')?.textContent || '').includes('Environment Variables'));
  // 使用者實際撞到的情況：看到「還沒連到資料庫」，照著做卻還是壞的。
  // 原因是他加了變數但沒重新部署 —— 而原本的說明只是輕輕帶過。
  check('有強調「填好之後一定要 Redeploy」', () => {
    const text = $('setupBlockedSteps')?.textContent || '';
    return /一定要 Redeploy|必須 Redeploy|一定要重新部署/.test(text);
  });
  check('有解釋「為什麼」要重新部署（部署時才讀進去）', () => {
    const text = $('setupBlockedSteps')?.textContent || '';
    return /部署時.{0,6}讀|只加變數不會/.test(text);
  });
  check('有指引使用者回引導網頁第 4 步（那裡有現成的複製按鈕）', () => {
    const text = $('setupBlockedSteps')?.textContent || '';
    // 這個畫面上的人剛好卡在「不知道去哪拿那幾個值」。
    // 引導網頁第 4 步有一張表、有複製按鈕，所以一定要把他指回去，
    // 而不是只說「去 Vercel 填」—— 他不知道要填什麼。
    return /第 4 步[^。]{0,40}(複製程式碼並部署|複製按鈕)/.test(text);
  });
  check('三個環境變數都有點名（少一個都會壞）', () => {
    const text = $('setupBlockedSteps')?.textContent || '';
    // 少了 SUPABASE_SECRET_KEY，網站連得動資料庫但「第一次設定」會壞，
    // 而且錯誤訊息一樣是「還沒連上資料庫」—— 完全指錯方向。
    return text.includes('SUPABASE_URL')
      && text.includes('SUPABASE_PUBLISHABLE_KEY')
      && text.includes('SUPABASE_SECRET_KEY');
  });

  // --- 表單欄位齊全 ---
  check('研究室名稱欄位存在', () => !!$('setupOrgName'));
  check('研究室代碼欄位存在', () => !!$('setupOrgCode'));
  check('管理者姓名欄位存在', () => !!$('setupAdminName'));
  check('Email 欄位是 email 型別', () => $('setupAdminEmail')?.type === 'email');
  check('密碼欄位是 password 型別', () => $('setupPassword')?.type === 'password');
  check('有確認密碼欄位', () => !!$('setupPasswordConfirm'));
  check('示範資料預設勾選', () => $('setupSampleData')?.checked === true);

  // --- 兩次密碼不一致時要即時擋下 ---
  $('setupOrgName').value = '測試研究室';
  $('setupAdminName').value = '測試員';
  $('setupAdminEmail').value = 'test@example.edu';
  $('setupPassword').value = 'abc12345';
  $('setupPasswordConfirm').value = 'different99';
  $('setupForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  check('密碼不一致會顯示錯誤', () => {
    const node = document.querySelector('[data-error-for="passwordConfirm"]');
    return !!node && !node.hidden && node.textContent.includes('不一樣');
  });
  check('密碼不一致時欄位標為錯誤', () => $('setupPasswordConfirm')?.getAttribute('aria-invalid') === 'true');

  // --- 品牌中性（不能出現作者的名字）---
  check('頁面沒有「鄭」字', () => {
    // 只看頁面內容，不看注入的測試腳本（腳本裡有關鍵字本身）。
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script').forEach(node => node.remove());
    const forbidden = String.fromCharCode(37165); // 「鄭」
    return !clone.innerHTML.includes(forbidden);
  });

  // --- 版面 ---
  check('設定卡片在桌面寬度不會太寬', () => {
    const width = document.querySelector('.setup-card')?.getBoundingClientRect().width || 0;
    return width > 300 && width <= 600;
  });
  check('頁面無水平溢出', () => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('未捕捉到 JavaScript 錯誤', () => window.__uiErrors.length === 0);

  const pre = document.createElement('pre');
  pre.id = 'ui-result';
  pre.textContent = JSON.stringify({ results, errors: window.__uiErrors, width: window.innerWidth }, null, 2);
  document.body.appendChild(pre);
}
window.addEventListener('load', () => setTimeout(report, 800));
</script>`;

// ---------------------------------------------------------------------------
// 情境 B：設定完成（看到正常的主系統）
// ---------------------------------------------------------------------------
const harnessReady = `
<script>
window.__uiErrors = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

window.fetch = async (url) => {
  if (String(url).includes('/api/config')) {
    return {
      ok: true,
      json: async () => ({
        app: 'lab-tracker-cloud',
        version: '1.0.0',
        backendConfigured: true,
        setupComplete: true,
        organizationName: '認知神經科學研究室',
        organizationCode: 'CNC',
        supabaseUrl: 'https://test.supabase.co',
        anonKey: 'sb_publishable_test'
      })
    };
  }
  return { ok: false, json: async () => ({}) };
};

function report() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };
  const $ = id => document.getElementById(id);
  const visible = el => !!el && !el.classList.contains('hidden');

  check('設定畫面沒有出現', () => !$('setupGate') || $('setupGate').hidden);
  check('主系統可見', () => !document.body.classList.contains('setup-pending'));
  check('頁首顯示研究室名稱', () => ($('brandTitle')?.textContent || '').includes('認知神經科學研究室'));
  check('品牌標記用研究室名稱的第一個字', () => $('brandMark')?.textContent === '認');
  check('網頁標題含研究室名稱', () => document.title.includes('認知神經科學研究室'));

  // 主系統功能仍在
  check('三個主頁籤', () => document.querySelectorAll('.tab-btn').length === 3);
  check('預設顯示收案待辦', () => {
    const action = $('tab-action');
    const calendar = $('tab-calendar');
    return visible(action) && !visible(calendar);
  });
  check('五張 KPI 卡片', () => document.querySelectorAll('.summary-card').length === 5);
  check('KPI 數值是數字', () => /^\\d+$/.test($('kpiOverdue').textContent.trim()));
  check('待辦表格有資料列', () => document.querySelectorAll('#actionTableBody tr').length > 0);
  check('月曆格數正確', () => document.querySelectorAll('.cal-day').length >= 28);

  // 頁籤切換
  document.querySelector('[data-tab="tab-calendar"]').click();
  check('切換到月曆', () => visible($('tab-calendar')) && !visible($('tab-action')));

  // 彈窗
  $('openAddSubjectBtn').click();
  check('新增個案彈窗可開啟', () => $('addSubjectModal').classList.contains('open'));
  document.querySelector('#addSubjectModal .modal-foot .btn-light')?.click();
  check('新增個案彈窗可關閉', () => !$('addSubjectModal').classList.contains('open'));

  check('頁首在桌面寬度為單列', () => Math.round(document.querySelector('.app-header').getBoundingClientRect().height) < 90);
  check('頁面無水平溢出', () => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('未捕捉到 JavaScript 錯誤', () => window.__uiErrors.length === 0);

  const pre = document.createElement('pre');
  pre.id = 'ui-result';
  pre.textContent = JSON.stringify({ results, errors: window.__uiErrors }, null, 2);
  document.body.appendChild(pre);
}
window.addEventListener('load', () => setTimeout(report, 800));
</script>`;

// ---------------------------------------------------------------------------
function runScenario(label, harness) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-cloud-ui-'));
  const pagePath = join(dir, 'ui-test.html');
  writeFileSync(pagePath, html.replace('</body>', harness + '\n</body>'));

  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
      '--virtual-time-budget=6000', '--dump-dom', `file://${pagePath}`
    ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const match = dom.match(/<pre id="ui-result">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.error(`✗ [${label}] 找不到測試結果，頁面可能未完成載入。`);
    return { failed: 1, total: 1 };
  }
  const payload = JSON.parse(match[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

  console.log(`\n【${label}】`);
  let failed = 0;
  for (const { name, ok, detail } of payload.results) {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed += 1;
  }
  if (payload.errors.length) {
    console.log('JavaScript 錯誤：');
    for (const error of payload.errors) console.log(`  ${error}`);
  }
  return { failed, total: payload.results.length };
}

const setupResult = runScenario('情境 A：全新部署（還沒設定）', harnessSetup);
const readyResult = runScenario('情境 B：設定完成（正常使用）', harnessReady);

const total = setupResult.total + readyResult.total;
const failed = setupResult.failed + readyResult.failed;
console.log(`\nUI 測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
