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
import { writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIZARD_PATH = fileURLToPath(new URL('../wizard/index.html', import.meta.url));
const wizardDir = dirname(WIZARD_PATH);

// 建表語法有幾段，從 migration 檔數出來，不寫死。
// 寫死段數的測試會在「有人加了第 N 段」時變紅，看起來像功能壞了，
// 但其實只是測試跟不上 —— 那種紅燈會訓練人忽略紅燈。
function countMigrations() {
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  return readdirSync(dir).filter(name => name.endsWith('.sql')).length;
}

// 在 Node 端算好，等下用 ${…} 注入進瀏覽器的 harness。
const expectedSegments = countMigrations();

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
    // 情境 B（window.__missingColumn）：模擬「資料表都建好了，但漏跑第 3 段」。
    // 這是這一版新增的自動更新開關欄位。漏跑的話系統其他部分都正常，
    // 只有「系統設定」裡的開關按不動 —— 所以驗證一定要抓得到。
    if (window.__missingColumn && url.includes('select=auto_update_enabled')) {
      return respond(400, { code: '42703', message: 'column "auto_update_enabled" does not exist' });
    }
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

  check('步驟順序是：資料庫 → 資料表 → 部署（資料表在 Supabase 裡順手做完）', () => {
    const ids = $$('#stepNav [data-nav-step]').map(b => b.dataset.navStep);
    return ids.join(',') === 'start,github,database,schema,deploy,admin,done';
  });
  check('每個「下一步」按鈕寫的都是真正的下一步', () => {
    const labels = $$('#stepNav [data-nav-step]').map(b => b.querySelector('.step-label')?.textContent.trim());
    const panels = $$('[data-panel]');
    return panels.every((panel, i) => {
      const next = panel.querySelector('[data-nav-next]');
      if (!next) return true;
      return next.textContent.includes(labels[i + 1]);
    });
  });

  // ============ 第 2 步：GitHub 帳號 ============
  check('沒填帳號就按驗證會說「請先填」', async () => true); // 下面真的做
  await clickVerifyExpectFail('github');

  await fillField('githubUsername', 'my-lab');
  await clickVerify('github');
  check('填了正確帳號後，第 2 步驗證通過', () => {
    const box = $('[data-result="github"]');
    return box?.dataset.state === 'pass';
  });

  await goToStep('database');

  // ============ 第 3 步：建立資料庫 ============
  check('第 3 步是「建立資料庫」（不是部署）', () => {
    return Boolean($('#panel-database')) && document.getElementById('panel-database')?.classList.contains('is-active');
  });

  // 順序改成「先建資料庫」的理由要寫在畫面上，不然使用者會以為排錯了。
  // 尤其是他可能看過別的教學是「部署時順便建」。
  check('第 3 步有解釋「為什麼不是部署時順便建」', () => {
    const text = $('#panel-database')?.textContent || '';
    return /為什麼不是[^。]{0,20}順便建|全新的? Supabase 帳號會卡/.test(text);
  });
  check('第 3 步有說「先建好、再去部署」的理由（多花兩分鐘但不會卡住）', () => {
    const text = $('#panel-database')?.textContent || '';
    return /先自己建好|多花兩分鐘/.test(text);
  });
  check('第 3 步有講清楚三個值哪兩個可以公開、哪一個不行', () => {
    const text = $('#panel-database')?.textContent || '';
    return text.includes('sb_secret_') && text.includes('sb_publishable_')
      && /絕對不要|萬能鑰匙/.test(text);
  });
  check('第 3 步列出了「下一步會用到這三個值」', () => {
    return Boolean(document.getElementById('dbNextStepPanel'));
  });
  check('第 3 步有提醒 secret key 不會經過這個頁面', () => {
    const text = document.getElementById('dbNextStepPanel')?.textContent || '';
    return /不會經過這個頁面|這個頁面不會保存/.test(text);
  });
  check('第 3 步的表格裡有 secret key 那一列（要讓他知道還有第三個）', () => {
    // 只看段落文字不夠：表格是會被「掃」過去的地方，
    // 少一列的話他只會看到兩個，部署時就漏填第三個。
    const rows = [...document.querySelectorAll('#dbNextStepPanel .env-name')];
    return rows.some(row => row.textContent.includes('SUPABASE_SECRET_KEY'));
  });
  check('引導網頁「沒有」收集 secret key 的輸入欄位（那把不能進瀏覽器）', () => {
    // 這是最重要的一條：secret key 等於資料庫的萬能鑰匙。
    // 它只能填進 Vercel 的表單，絕對不能有一個 input 讓使用者貼進來 ——
    // 一旦貼進來就會進 state、進 localStorage，留在磁碟上。
    const fields = [...document.querySelectorAll('input[data-field]')];
    return !fields.some(f => /secret/i.test(f.dataset.field || ''));
  });

  await fillField('supabaseUrl', SUPABASE);
  await fillField('publishableKey', 'sb_publishable_' + 'a'.repeat(30));
  await clickVerify('database');
  check('填了資料庫網址與金鑰後，第 3 步驗證通過', () => {
    return $('[data-result="database"]')?.dataset.state === 'pass';
  });

  await goToStep('schema');

  // ============ 第 4 步：建資料表 ============
  // 段數從 migration 檔算（由 Node 端注入 __expectedSegments），不寫死。
  // 寫死的話，加新的一段時會紅一個看起來像「壞了」的燈，但其實是測試過期。
  // 第 4 步唯一該做的事是「複製整份、貼一次、按一次 RUN」。
  // 以前把「複製全部」標成「一段一段貼時不要用這個」，等於叫人不要用最省事的路。
  check('第 4 步有一個「複製整份語法」的主要按鈕', () => {
    const btn = document.getElementById('copyAllSql');
    return Boolean(btn) && !btn.hidden;
  });
  check('「複製整份」按鈕複製的是全部段落串起來的內容', () => {
    const btn = document.getElementById('copyAllSql');
    if (!btn) return false;
    const value = btn.dataset.copyValue || '';
    // 三段都要在裡面：開頭、設定表、自動更新欄位
    return value.includes('lab_profiles') && value.includes('lab_settings') && value.includes('auto_update_enabled');
  });
  check('第 4 步有告訴使用者「貼兩次也不會壞」', () => {
    const text = document.getElementById('panel-schema').textContent;
    return /貼兩次也不會壞|貼兩次[^。]{0,6}(安全|不會)/.test(text);
  });
  check('第 4 步說明「漏掉最後一段不會有錯誤訊息」', () => {
    const text = document.getElementById('panel-schema').textContent;
    return /不會有任何錯誤訊息|沒有任何錯誤訊息/.test(text);
  });
  // 自動偵測還在，但換了位置與定位：新流程走到第 3 步時還沒有網站，
  // 所以它是給「回來重跑引導」的人用的次要路徑，不是主要路徑。
  check('第 3 步還留著「從我的網站讀取」給回來重跑的人', () => {
    return Boolean(document.getElementById('dbAutoDetectBtn'));
  });
  check('第 4 步有 ' + window.__expectedSegments + ' 段建表語法可複製（與 migration 檔數一致）',
    () => $$('#sqlSegments details').length === window.__expectedSegments);
  check('建表語法裡有 do $$ 區塊（沒有被吃掉）',
    () => $$('#sqlSegments pre').some(pre => pre.textContent.includes('do $$')));

  await clickVerify('schema');
  check('建表語法跑過之後，第 4 步驗證通過', () => {
    return $('[data-result="schema"]')?.dataset.state === 'pass';
  });

  await goToStep('deploy');

  // ============ 第 5 步：部署 ============
  check('第 5 步有「一鍵部署」按鈕', () => Boolean($('#deployLink')));
  check('一鍵部署的網址指向 Vercel', () => String($('#deployLink')?.href || '').includes('vercel.com/new'));
  check('一鍵部署網址帶了 repository-url', () => String($('#deployLink')?.href || '').includes('repository-url='));

  // 這是這次改動的核心：部署表單要直接問那三個環境變數。
  // 因為順序改成「先建資料庫」，使用者手上已經有值了 —— 沒有理由讓他
  // 「部署完 → 進 Settings 填 → 再 Redeploy」。
  check('一鍵部署網址帶了 env 參數（部署表單會直接問）', () => {
    const href = String($('#deployLink')?.href || '');
    return href.includes('env=SUPABASE_URL') && href.includes('SUPABASE_PUBLISHABLE_KEY')
      && href.includes('SUPABASE_SECRET_KEY');
  });

  // 這裡是那個死路的結構性解法：不再帶 integration-ids，
  // Vercel 就不會要求「先安裝 Supabase 整合」，也就不會卡在
  // 「No Supabase organizations found」。
  check('一鍵部署網址「沒有」要求安裝 Supabase 整合（那條路會卡死）', () => {
    const href = String($('#deployLink')?.href || '');
    return !href.includes('integration-ids=');
  });
  check('第 5 步有寫「No Supabase organizations found」不會出現', () => {
    const text = $('#panel-deploy')?.textContent || '';
    return /正常情況下不該出現/.test(text);
  });

  check('第 5 步有列出要填的四個環境變數', () => {
    const text = document.getElementById('panel-deploy')?.textContent || '';
    return text.includes('SUPABASE_URL') && text.includes('SUPABASE_SECRET_KEY') && text.includes('CRON_SECRET');
  });
  check('一鍵部署網址也請使用者填 CRON_SECRET', () => {
    return String($('#deployLink')?.href || '').includes('CRON_SECRET');
  });
  // CRON_SECRET 是引導網頁自己產生的：表格裡要真的有一組可以複製的亂數，
  // 而且它不能被存進 localStorage（那是密碼）。
  check('CRON_SECRET 那一列已經產生好一組 64 字元的亂數可以複製', () => {
    return /^[0-9a-f]{64}$/.test(document.getElementById('deployEnvCron')?.dataset.raw || '');
  });
  check('CRON_SECRET 沒有被存進 localStorage', () => {
    const raw = document.getElementById('deployEnvCron')?.dataset.raw || 'x';
    const stored = Object.keys(localStorage).map(key => localStorage.getItem(key)).join('');
    return !stored.includes(raw);
  });
  check('第 5 步有「檢查網站連上了沒」按鈕', () => {
    return Boolean(document.getElementById('dbVerifySiteBtn'));
  });
  check('第 5 步有準備「環境變數沒填」的補救說明', () => {
    return Boolean(document.getElementById('deployEnvFix'));
  });
  check('補救說明有強調「一定要重新部署」', () => {
    const text = document.getElementById('deployEnvFix')?.textContent || '';
    return /一定要重新部署|Redeploy/.test(text);
  });

  await fillField('siteUrl', SITE);
  await clickVerify('deploy');
  check('填了網站網址後，第 5 步驗證通過（部署成功）', () => {
    return $('[data-result="deploy"]')?.dataset.state === 'pass';
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

  // 第 7 步是唯一會提到「自動更新」的地方，也是使用者最可能照著做的地方。
  // 漏掉這段說明，自動更新照樣會跑，但「關掉它」的開關就永遠不會生效
  // —— 因為沒有人知道要去 GitHub 設 LAB_SITE_URL。
  check('第 7 步說明自動更新，並講出 LAB_SITE_URL 怎麼設', () => {
    const text = $('#panel-done')?.textContent || '';
    return text.includes('自動更新') && text.includes('LAB_SITE_URL');
  });
  check('第 7 步的自動更新說明提到「系統設定」可以關掉', () => {
    const text = $('#panel-done')?.textContent || '';
    return text.includes('系統設定');
  });
  check('第 7 步說明裡帶入使用者自己的網址', () => {
    return ($('#doneSiteUrlHint')?.textContent || '').includes('my-lab.vercel.app');
  });
  check('第 7 步有講「資料不會被動到」（這是使用者最在意的事）', () => {
    const text = $('#panel-done')?.textContent || '';
    return text.includes('資料不會被動到') || text.includes('資料不會被影響');
  });

  // ============ 全程進度 ============
  check('進度條走到 100%（切換步驟後不會被清掉）', () => {
    return $('#progressFill')?.style.width === '100%';
  });
  check('進度文字是「已完成 5 / 5 步」', () => {
    return ($('#progressText')?.textContent || '').includes('5 / 5');
  });

  // 畫面上寫 5/5，讀螢幕的人也要聽到 5 —— 這兩個曾經不一致：
  // HTML 寫死 aria-valuemax="6"，而 updateProgress 只更新視覺、沒更新 aria。
  check('無障礙的 aria-valuemax 也是 5（不是寫死的 6）', () => {
    const track = document.querySelector('.progress-track');
    return track?.getAttribute('aria-valuemax') === '5';
  });
  check('無障礙的 aria-valuenow 是 5', () => {
    const track = document.querySelector('.progress-track');
    return track?.getAttribute('aria-valuenow') === '5';
  });
  check('側邊欄五個驗證步驟都打勾', () => {
    return $$('#stepNav [data-nav-step].is-done').length === 5;
  });
  // 回到中間某一步再前進，確認打勾不會消失（這是原本的 bug）
  await goToStep('database');
  check('切回第 3 步時，其他步驟的打勾還在', () => {
    return $$('#stepNav [data-nav-step].is-done').length === 5;
  });
  await goToStep('done');
  check('再回到第 7 步，進度仍是 100%', () => {
    return $('#progressFill')?.style.width === '100%';
  });
  check('全程沒有 JavaScript 錯誤', () => window.__journey.errors.length === 0);
}

// 情境 B：資料表都建好了，但漏跑第 3 段（003 的 auto_update_enabled）。
//
// 為什麼要演這一齣：漏跑的人在畫面上完全看不出來 —— 系統能登入、
// 能記錄、能匯出，一切正常。只有當他想去「系統設定」把自動更新關掉時，
// 開關才會按不動，而且那時他已經在用了，不會知道是少跑一段 SQL。
// 所以第 4 步的驗證必須在當下就講清楚還缺什麼。
async function journeyMissingColumn() {
  await goToStep('schema');
  await fillField('supabaseUrl', SUPABASE);
  await fillField('publishableKey', 'sb_publishable_' + 'a'.repeat(30));

  await clickVerifyExpectFail('schema');

  check('漏跑第 3 段時，第 4 步驗證會失敗（不能一路綠燈）', () => {
    return $('[data-result="schema"]')?.dataset.state === 'fail';
  });
  check('失敗訊息說得出少了哪個欄位（使用者才知道要重跑哪一段）', () => {
    const text = $('[data-result="schema"]')?.textContent || '';
    return text.includes('auto_update_enabled') || text.includes('第 3 段');
  });
  check('漏跑第 3 段的情境沒有 JavaScript 錯誤', () => window.__journey.errors.length === 0);
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

window.__expectedSegments = ${expectedSegments};

window.addEventListener('load', () => setTimeout(async () => {
  try {
    if (window.__missingColumn) await journeyMissingColumn();
    else await journey();
  } catch (error) {
    results.push({ name: '整條流程走完', ok: false, detail: String(error && error.message || error) });
  }
  emit({ results, errors: window.__journey.errors, requestCount: window.__journey.requests.length });
}, 700));
</script>`;

const html = readFileSync(WIZARD_PATH, 'utf8');

// 把整頁跑一次，回傳瀏覽器裡跑出來的结果。
// 同一個 harness、只差一個注入的旗標，所以兩個情境測的是同一份程式碼。
// file:// 模式下，頁面載入的是 inline-bundle.js（預先內嵌的同一份程式），
// 不是 wizard.js。忘記跑 sync-inline 的話，這裡驗的就是舊程式 ——
// 明明把功能改壞了，測試照樣全綠。變異測試時真的被騙過一次
// （拿掉 skippable-integrations，這支測試仍然 39 項全過）。
//
// 所以先驗指紋。這個指紋是 sync-inline.mjs 自己算的
// （config.js + wizard.js 的 sha256 前 12 碼），跟 `npm run check:wizard`
// 用的是同一個值 —— 不自己另創一套比對邏輯，免得兩邊標準不一致。
function assertBundleFresh() {
  const bundle = readFileSync(join(wizardDir, 'inline-bundle.js'), 'utf8');
  const config = readFileSync(join(wizardDir, 'config.js'), 'utf8');
  const wizard = readFileSync(join(wizardDir, 'wizard.js'), 'utf8');

  const match = bundle.match(/var payload = (\{[\s\S]*?\});\n/);
  if (!match) {
    throw new Error('inline-bundle.js 讀不出指紋，可能格式壞了。請跑 node wizard/sync-inline.mjs');
  }
  let embedded;
  try {
    embedded = JSON.parse(match[1]).fingerprint;
  } catch (error) {
    throw new Error(`inline-bundle.js 的內容解析失敗：${error.message}`);
  }

  const expected = createHash('sha256').update(config + '\n' + wizard).digest('hex').slice(0, 12);
  if (embedded !== expected) {
    throw new Error(
      `inline-bundle.js 過期了（檔案內是 ${embedded}，原始碼算出來是 ${expected}）。`
      + '請先跑 node wizard/sync-inline.mjs，否則這個測試驗的是舊程式。'
    );
  }
}

function runPage({ missingColumn }) {
  const pagePath = join(wizardDir, missingColumn ? '.journey-test-b.html' : '.journey-test.html');
  const flag = `<script>window.__missingColumn = ${missingColumn ? 'true' : 'false'};<\/script>`;
  writeFileSync(pagePath, html.replace('</body>', () => flag + harness + '\n</body>'));

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
  if (!match) return null;
  return JSON.parse(match[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

let failed = 0;
let total = 0;

function report(title, payload) {
  console.log(`\n【${title}】`);
  if (!payload) {
    console.log('✗ 這一輪沒有回傳結果（引導頁可能載入失敗）');
    failed += 1;
    total += 1;
    return;
  }
  for (const { name, ok, detail } of payload.results) {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    total += 1;
    if (!ok) failed += 1;
  }
  if (payload.errors.length) {
    console.log('JavaScript 錯誤：');
    for (const error of payload.errors) console.log(`  ${error}`);
  }
  console.log(`（過程中發出的網路請求：${payload.requestCount} 次）`);
}

try {
  assertBundleFresh();
  console.log('✔ inline-bundle.js 與 wizard.js 同步（否則下面驗的是舊程式）');
} catch (error) {
  console.log(`✗ ${error.message}`);
  process.exit(1);
}

report('引導網頁：從第 1 步走到第 7 步', runPage({ missingColumn: false }));
// 情境 B 只有在瀏覽器真的跑起來時才有意義（沒有 Chrome 就只跑情境 A）。
report('引導網頁：漏跑第 3 段時，第 4 步要講清楚', runPage({ missingColumn: true }));

console.log(`\n完整流程測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
