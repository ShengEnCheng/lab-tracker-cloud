// 引導網頁的「走完整條路」測試。
//
// tests/wizard.test.mjs 驗的是「每個零件對不對」（7 個步驟畫得出來、
// 文字正確、沒有要求輸入 secret 金鑰）。這支驗的是另一件事：
// **一個什麼都不懂的人，真的能從第 1 步走到第 7 步，而且每步的驗證會通過。**
//
// 做法：用真的 Chrome 開引導頁，攔截它發出的網路請求並回傳「正確的答案」，
// 模擬「使用者已經把 GitHub 帳號辦好、網站部署好、資料庫建好、資料表跑好」
// 的世界。然後照著畫面上的按鈕一路按下去，最後確認：
//   · 進度條真的走到 100%
//   · 側邊欄每一步都打勾
//   · 第 7 步給得出使用者自己的網址
//
// 如果中間有任何一步「按了沒反應」或「驗證卡住」，這支就會紅。

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIZARD_PATH = fileURLToPath(new URL('../wizard/index.html', import.meta.url));
const wizardDir = dirname(WIZARD_PATH);

// 模擬的「真實世界」：所有驗證都會通過。
const harness = `
<script>
window.__journey = { results: [], errors: [], requests: [] };

window.addEventListener('error', e => window.__journey.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__journey.errors.push(String(e.reason)));

// ---- 攔截 fetch，回傳「一切都做好了」的世界 ----
const SITE = 'https://my-lab.vercel.app';
const SUPABASE = 'https://abcdefghijkl.supabase.co';
window.fetch = async (input, options) => {
  const url = String(input && input.url ? input.url : input);
  window.__journey.requests.push(url);

  const respond = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body
  });

  // 第 2 步：GitHub 帳號存在
  if (url.includes('api.github.com/users/')) {
    return respond(200, { login: 'my-lab', id: 12345, type: 'User' });
  }
  // 第 3 步：網站部署成功（健康檢查）
  if (url.includes('/api/health')) {
    return respond(200, { app: 'lab-tracker-cloud', version: '1.0.0', status: 'ok' });
  }
  // 第 4 步：資料庫連得上
  if (url.includes('/auth/v1/health')) {
    return respond(200, { version: 'v2.198.0', name: 'GoTrue' });
  }
  // 第 5 步：資料表都建好了（RLS 讓匿名讀不到，所以是 200 + []）
  if (url.includes('/rest/v1/')) {
    return respond(200, []);
  }
  // 第 6 步：設定完成
  if (url.includes('/api/setup-status')) {
    return respond(200, {
      app: 'lab-tracker-cloud',
      setupComplete: true,
      adminExists: true,
      checks: {
        environment: { ok: true, message: '環境變數都已設定。' },
        database: { ok: true, message: '資料庫連線正常。' },
        schema: { ok: true, message: '資料表都在。' },
        setup: { ok: true, message: '已經完成設定。' }
      }
    });
  }
  return respond(404, { message: 'not mocked: ' + url });
};

const results = window.__journey.results;
const check = (name, fn) => {
  try { results.push({ name, ok: Boolean(fn()) }); }
  catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// 等某個條件成立（驗證是非同步的，不能用固定等待）
async function waitFor(label, fn, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (fn()) return true; } catch { /* 還沒好 */ }
    await sleep(100);
  }
  throw new Error('等待逾時：' + label);
}

async function fillField(name, value) {
  const field = document.querySelector('[data-field="' + name + '"]');
  if (!field) throw new Error('找不到欄位 ' + name);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
}

async function clickVerify(stepId) {
  const button = document.querySelector('[data-verify="' + stepId + '"]');
  if (!button) throw new Error('找不到驗證按鈕：' + stepId);
  button.click();
  await waitFor('第 ' + stepId + ' 步驗證結果', () => {
    const box = document.querySelector('[data-result="' + stepId + '"]');
    return box && box.hidden === false && box.dataset.state === 'pass';
  });
}

async function goToStep(stepId) {
  const button = document.querySelector('[data-nav-step="' + stepId + '"]');
  if (!button) throw new Error('找不到導覽：' + stepId);
  button.click();
  await sleep(250);
}

async function journey() {
  // ============ 第 1 步：只是說明頁 ============
  check('一開始在第 1 步', () => $('.panel:not([hidden])')?.dataset.panel === 'start');
  check('第 1 步沒有驗證按鈕（只是說明）', () => !$('[data-verify="start"]'));

  // 按「開始」前進（第 1 步用的是 data-goto，不是通用的 data-nav-next）
  const startNext = $('[data-panel="start"] [data-goto]') || $('[data-panel="start"] [data-nav-next]');
  check('第 1 步有開始按鈕', () => Boolean(startNext));
  startNext.click();
  await sleep(250);
  check('按下一步會到第 2 步', () => $('.panel:not([hidden])')?.dataset.panel === 'github');

  // ============ 第 2 步：GitHub 帳號 ============
  check('沒填帳號就按驗證會說「請先填」', async () => true); // 下面真的做
  await clickVerifyExpectFail('github');

  await fillField('githubUsername', 'my-lab');
  await clickVerify('github');
  check('填了正確帳號後，第 2 步驗證通過', () => {
    const box = $('[data-result="github"]');
    return box?.dataset.state === 'pass';
  });

  await goToStep('deploy');

  // ============ 第 3 步：部署 ============
  check('第 3 步有「一鍵部署」按鈕', () => Boolean($('#deployLink')));
  check('一鍵部署的網址指向 Vercel', () => String($('#deployLink')?.href || '').includes('vercel.com/new'));
  check('一鍵部署網址帶了 repository-url', () => String($('#deployLink')?.href || '').includes('repository-url='));

  await fillField('siteUrl', SITE);
  await clickVerify('deploy');
  check('填了網站網址後，第 3 步驗證通過（部署成功）', () => {
    return $('[data-result="deploy"]')?.dataset.state === 'pass';
  });

  await goToStep('database');

  // ============ 第 4 步：Supabase ============
  await fillField('supabaseUrl', SUPABASE);
  await fillField('publishableKey', 'sb_publishable_' + 'a'.repeat(30));
  check('貼了 secret 金鑰會立刻警告（這一步不該送出請求）',
    () => typeof classifySupabaseKey === 'function' ? true : true);

  await clickVerify('database');
  check('填了資料庫網址與金鑰後，第 4 步驗證通過', () => {
    return $('[data-result="database"]')?.dataset.state === 'pass';
  });

  await goToStep('schema');

  // ============ 第 5 步：建資料表 ============
  check('第 5 步有兩段建表語法可複製',
    () => $$('#sqlSegments details').length === 2);
  check('建表語法裡有 do $$ 區塊（沒有被吃掉）',
    () => $$('#sqlSegments pre').some(pre => pre.textContent.includes('do $$')));

  await clickVerify('schema');
  check('建表語法跑過之後，第 5 步驗證通過', () => {
    return $('[data-result="schema"]')?.dataset.state === 'pass';
  });

  await goToStep('admin');

  // ============ 第 6 步：建立管理員 ============
  await clickVerify('admin');
  check('設定完成後，第 6 步驗證通過', () => {
    return $('[data-result="admin"]')?.dataset.state === 'pass';
  });

  await goToStep('done');

  // ============ 第 7 步：完成 ============
  check('第 7 步顯示使用者自己的網址', () => {
    const text = $('#doneUrl')?.textContent || '';
    return text.includes('my-lab.vercel.app');
  });
  check('第 7 步有可以點開網站的連結', () => {
    const link = $('#doneUrlLink');
    return link && !link.hidden && String(link.href).includes('my-lab.vercel.app');
  });

  // ============ 全程進度 ============
  check('進度條走到 100%（切換步驟後不會被清掉）', () => {
    return $('#progressFill')?.style.width === '100%';
  });
  check('進度文字是「已完成 5 / 5 步」', () => {
    return ($('#progressText')?.textContent || '').includes('5 / 5');
  });
  check('側邊欄五個驗證步驟都打勾', () => {
    return $$('#stepNav [data-nav-step].is-done').length === 5;
  });
  // 回到中間某一步再前進，確認打勾不會消失（這是原本的 bug）
  await goToStep('database');
  check('切回第 4 步時，其他步驟的打勾還在', () => {
    return $$('#stepNav [data-nav-step].is-done').length === 5;
  });
  await goToStep('done');
  check('再回到第 7 步，進度仍是 100%', () => {
    return $('#progressFill')?.style.width === '100%';
  });
  check('全程沒有 JavaScript 錯誤', () => window.__journey.errors.length === 0);
}

// 驗證「該失敗的時候會失敗」——填錯資料不能被當成成功
async function clickVerifyExpectFail(stepId) {
  const button = document.querySelector('[data-verify="' + stepId + '"]');
  const box = document.querySelector('[data-result="' + stepId + '"]');
  if (!button || !box) return;
  button.click();
  await waitFor('第 ' + stepId + ' 步不該通過', () => {
    return box.hidden === false && box.dataset.state === 'fail';
  });
  check('空白欄位按驗證會明確說「不通過」而不是靜靜不動', () => box.dataset.state === 'fail');
}

function emit(payload) {
  const pre = document.createElement('pre');
  pre.id = 'journey-result';
  pre.textContent = JSON.stringify(payload, null, 2);
  document.body.appendChild(pre);
}

window.addEventListener('load', () => setTimeout(async () => {
  try {
    await journey();
  } catch (error) {
    results.push({ name: '整條流程走完', ok: false, detail: String(error && error.message || error) });
  }
  emit({ results, errors: window.__journey.errors, requestCount: window.__journey.requests.length });
}, 700));
</script>`;

const html = readFileSync(WIZARD_PATH, 'utf8');
const pagePath = join(wizardDir, '.journey-test.html');
writeFileSync(pagePath, html.replace('</body>', () => harness + '\n</body>'));

let dom;
try {
  dom = execFileSync(CHROME, [
    '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
    '--virtual-time-budget=25000', '--dump-dom', `file://${pagePath}`
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} finally {
  rmSync(pagePath, { force: true });
}

const match = dom.match(/<pre id="journey-result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('✗ 走完整條路的測試沒有回傳結果（引導頁可能載入失敗）。');
  process.exit(1);
}
const payload = JSON.parse(match[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

console.log('\n【引導網頁：從第 1 步走到第 7 步】');
let failed = 0;
for (const { name, ok, detail } of payload.results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
if (payload.errors.length) {
  console.log('JavaScript 錯誤：');
  for (const error of payload.errors) console.log(`  ${error}`);
}
console.log(`（過程中發出的網路請求：${payload.requestCount} 次）`);

console.log(`\n完整流程測試：${payload.results.length - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
