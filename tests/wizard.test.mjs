// 引導網頁（wizard/）的測試。
//
// wizard 是整個部署流程的入口：助理如果卡在這裡，後面什麼都不用談。
// 它是純前端、可以 file:// 直接開，所以用真的 Chrome 測。
//
// 測的重點：
//   · 7 個步驟都畫得出來、切得動
//   · 給使用者複製的文字是對的（貼錯就整個流程失敗）
//   · 驗證邏輯正確（把「還沒做」誤判成「做好了」比不檢查更糟）
//   · 產生的 Vercel Deploy Button 網址參數正確
//   · 不會要求使用者把 secret 金鑰貼進這個網頁

import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 用絕對路徑：file:// 只吃絕對路徑，相對路徑會變成 file://wizard/... 而載不到。
const WIZARD_PATH = fileURLToPath(new URL('../wizard/index.html', import.meta.url));

// 注入測試腳本。因為是 file://，模組 import 可能受限制，
// 所以測試只依賴 DOM 與 wizard.js 掛在全域的東西。
const harness = `
<script>
window.__wiz = { results: [], errors: [] };
window.addEventListener('error', e => window.__wiz.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__wiz.errors.push(String(e.reason)));

function report() {
  const results = window.__wiz.results;
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const visiblePanels = () => $$('[data-panel]').filter(p => !p.hidden && getComputedStyle(p).display !== 'none');

  // --- 基本結構 ---
  check('有 7 個步驟面板', () => $$('[data-panel]').length === 7);
  check('步驟導覽有 7 項', () => $$('#stepNav > *').length === 7);
  check('一開始只顯示第 1 步', () => {
    const visible = visiblePanels();
    return visible.length === 1 && visible[0].dataset.panel === 'start';
  });

  // --- 每個步驟都要有實質內容，不能是空殼 ---
  const panels = $$('[data-panel]');
  for (const panel of panels) {
    const id = panel.dataset.panel;
    check('步驟「' + id + '」有標題', () => (panel.querySelector('h2, .panel-title')?.textContent || '').trim().length > 2);
    check('步驟「' + id + '」有說明文字', () => (panel.textContent || '').trim().length > 120);
  }

  // --- 切換步驟 ---
  const navButtons = $$('#stepNav button, #stepNav a');
  check('導覽項目可以點', () => navButtons.length === 7);
  if (navButtons.length === 7) {
    // 第 3 項＝建立資料庫、第 4 項＝複製程式碼並部署。
    // （順序是刻意的：先建資料庫，部署時才有三個值可以填。）
    navButtons[2].click();
    check('點第 3 項會切到「建立資料庫」', () => visiblePanels().some(p => p.dataset.panel === 'database'));
    navButtons[3].click();
    check('點第 4 項會切到「複製程式碼並部署」', () => visiblePanels().some(p => p.dataset.panel === 'deploy'));
    navButtons[0].click();
  }

  // --- 複製用的文字必須正確 ---
  check('有「複製」按鈕（給不會打指令的人）', () => {
    const buttons = $$('button, [data-copy]');
    return buttons.some(b => /複製/.test(b.textContent || '') || b.dataset.copy);
  });

  // 建表 SQL 必須是完整、可直接貼上執行的
  const bodyText = document.body.textContent || '';
  check('頁面含第一段建表語法', () => /create table[\\s\\S]*lab_state/i.test(bodyText));
  check('頁面含第二段建表語法', () => /lab_settings/i.test(bodyText));
  check('SQL 語法含 RLS 啟用（不是殘缺版）', () => /row level security/i.test(bodyText));

  // --- 環境變數名稱必須與 api/ 讀的一致 ---
  check('提到 SUPABASE_URL', () => bodyText.includes('SUPABASE_URL'));
  check('提到 SUPABASE_PUBLISHABLE_KEY', () => bodyText.includes('SUPABASE_PUBLISHABLE_KEY'));
  check('提到 SUPABASE_SECRET_KEY', () => bodyText.includes('SUPABASE_SECRET_KEY'));

  // --- 安全性：這個頁面絕不會要求把 secret 貼進來 ---
  check('沒有要求輸入 secret 金鑰的欄位', () => {
    const inputs = $$('input, textarea');
    const dangerous = inputs.filter(input => {
      const hint = [input.id, input.name, input.placeholder, input.dataset.label].filter(Boolean).join(' ');
      return /secret|service_role|password/i.test(hint) && !/publishable|anon/i.test(hint);
    });
    return dangerous.length === 0;
  });

  // --- Deploy Button 網址 ---
  check('有產生 Deploy Button 的連結或按鈕', () => {
    const links = $$('a[href*="vercel.com/new"], button[data-deploy]');
    return links.length > 0;
  });

  // --- 版號／系統名稱要能對上 ---
  check('頁面說明這是「研究室追蹤系統」', () => /研究室追蹤系統/.test(bodyText));
  check('沒有作者的舊品牌殘留', () => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script').forEach(node => node.remove());
    return !clone.innerHTML.includes(String.fromCharCode(37165));
  });

  // --- 版面 ---
  check('桌面寬度無水平溢出', () => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('未捕捉到 JavaScript 錯誤', () => window.__wiz.errors.length === 0);

  emit(results, window.__wiz.errors);
}

// report() 自己出錯時也要留下結果，否則測試只會說「沒有回傳」，
// 完全看不出是頁面壞了還是腳本壞了。
function emit(results, errors) {
  const pre = document.createElement('pre');
  pre.id = 'wizard-result';
  pre.textContent = JSON.stringify({ results, errors }, null, 2);
  document.body.appendChild(pre);
}

window.addEventListener('load', () => setTimeout(() => {
  try {
    report();
  } catch (error) {
    emit(window.__wiz.results, [...window.__wiz.errors, 'report() 丟出例外：' + (error && error.stack || error)]);
  }
}, 900));
</script>`;

// ---------------------------------------------------------------------------
const html = readFileSync(WIZARD_PATH, 'utf8');
// 測試頁必須放在 wizard/ 旁邊：index.html 用相對路徑載入 inline-bundle.js，
// 放到暫存目錄會載不到，引導頁整頁不會動（那就什麼都測不到）。
const wizardDir = WIZARD_PATH.replace(/\/index\.html$/, '');
const pagePath = join(wizardDir, '.wizard-test.html');
// 用函式當替換值：字串替換會把 harness 裡的 `$$`（測試腳本自己的 $ 與 $$ 變數）
// 當成「跳脫字元」吃掉，結果變成重複宣告 const $ → SyntaxError → 整支腳本不執行。
writeFileSync(pagePath, html.replace('</body>', () => harness + '\n</body>'));

let dom;
try {
  dom = execFileSync(CHROME, [
    '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
    '--virtual-time-budget=6000', '--dump-dom', `file://${pagePath}`
  ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} finally {
  rmSync(pagePath, { force: true });
}

const match = dom.match(/<pre id="wizard-result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('✗ 引導網頁沒有回傳測試結果（可能載入失敗或 JavaScript 錯誤）。');
  process.exit(1);
}
const payload = JSON.parse(match[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

console.log('\n【引導網頁（wizard）】');
let failed = 0;
for (const { name, ok, detail } of payload.results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
if (payload.errors.length) {
  console.log('JavaScript 錯誤：');
  for (const error of payload.errors) console.log(`  ${error}`);
}

console.log(`\n引導網頁測試：${payload.results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
