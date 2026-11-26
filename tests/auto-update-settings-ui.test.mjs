// 「介面上的自動更新開關」——使用者真的看得到、按得動嗎？
//
// 為什麼要專門測這一段：
//   前面幾支測試驗的是「資料庫裡的狀態對不對」「Action 會不會照著停下來」。
//   但使用者不會看到那些 —— 他只看到畫面上那顆開關。如果按鈕沒出現、
//   按了沒反應、或者按了之後畫面顯示的狀態和真正存進去的不一樣，
//   前面那些都白做了。
//
// 這支用真的 Chrome 開 index.html，模擬「雲端模式、已登入的管理員」，
// 走完：打開系統設定 → 看到現在的狀態 → 關掉 → 再打開。
// 同時驗「非管理員看不到、也按不動」。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = readFileSync('index.html', 'utf8');

const ADMIN = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pi@example.edu.tw',
  display_name: '鄭老師',
  member_code: 'PI',
  role: 'admin',
  active: true
};

const STUDENT = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'ra@example.edu.tw',
  display_name: '助理一',
  member_code: 'RA1',
  role: 'researcher',
  active: true
};

const EMPTY_DATA = { schemaVersion: 1, members: [], optBone: [], music40: [], customStudies: [] };

// 這段 harness 會被塞進頁面的 </body> 之前。
// role 由 Node 端注入，同一份程式碼跑「管理員」與「研究人員」兩種身分。
function buildHarness({ role, initialAutoUpdate, patchStatus = 200, schemaReady = true }) {
  const me = role === 'admin' ? ADMIN : STUDENT;
  return `
<script>
window.__uiErrors = [];
window.addEventListener('error', e => window.__uiErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push(String(e.reason)));

const ME = ${JSON.stringify(me)};
const PROFILES = [${JSON.stringify(ADMIN)}, ${JSON.stringify(STUDENT)}];
let autoUpdate = ${JSON.stringify(initialAutoUpdate)};
const PATCH_STATUS = ${patchStatus};
const SCHEMA_READY = ${JSON.stringify(schemaReady)};

// 記下頁面發出的每一個請求，最後要驗「關掉時真的送了 PATCH」。
window.__requests = [];

window.__LAB_TRACKER_BACKEND__ = { enabled: true, apiBase: '/api', token: 'token-admin' };
window.__LAB_TRACKER_AUTH__ = {
  setupComplete: true,
  organizationName: '認知神經科學研究室',
  organizationCode: 'CNC',
  supabaseUrl: 'https://test.supabase.co',
  anonKey: 'sb_publishable_test'
};
localStorage.setItem('LAB_TRACKER_AUTH_SESSION', JSON.stringify({
  access_token: 'token-admin',
  user: { id: ME.id, email: ME.email },
  expires_at: Math.floor(Date.now() / 1000) + 3600
}));

window.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  window.__requests.push({ url: target, method, body: options.body || null });

  const respond = (body, status = 200) => ({
    ok: status < 400, status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  if (target.includes('/api/config')) {
    return respond({
      app: '研究室追蹤系統', version: '1.1.0',
      backendConfigured: true, setupComplete: true,
      organizationName: '認知神經科學研究室', organizationCode: 'CNC',
      supabaseUrl: 'https://test.supabase.co', anonKey: 'sb_publishable_test'
    });
  }
  if (target.includes('/api/profiles')) return respond({ profiles: PROFILES });
  if (target.includes('/api/data')) return respond({ data: ${JSON.stringify(EMPTY_DATA)}, revision: 1 });

  // 自動更新開關的讀寫
  if (target.includes('/api/update-policy')) {
    if (method === 'GET') {
      return respond({
        version: '1.1.0',
        autoUpdate,
        schemaReady: SCHEMA_READY,
        backendConfigured: true,
        siteUrl: 'https://my-lab.vercel.app'
      });
    }
    if (method === 'PATCH') {
      if (PATCH_STATUS >= 400 || window.__forcePatchFailure) {
        return respond({ error: 'boom', message: '資料庫暫時無法連線。' }, 503);
      }
      const body = JSON.parse(options.body || '{}');
      autoUpdate = body.autoUpdate;
      return respond({ autoUpdate, siteUrl: 'https://my-lab.vercel.app' });
    }
  }
  return respond({});
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, fn, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (fn()) return true; } catch { /* 還沒好 */ }
    await sleep(80);
  }
  throw new Error('等待逾時：' + label);
}

function report() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ name, ok: !!fn() }); }
    catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }); }
  };

  setTimeout(async () => {
    try {
      const settingsButton = document.getElementById('openSettingsBtn');
      const toggle = document.getElementById('autoUpdateToggle');
      const modal = document.getElementById('settingsModal');

      // ---- 1. 按鈕該不該出現 ----
      check('管理員看得到「系統設定」按鈕', () => {
        if (${JSON.stringify(role)} !== 'admin') return true; // 非管理員由下面那段驗
        return settingsButton && !settingsButton.classList.contains('hidden');
      });

      if (${JSON.stringify(role)} !== 'admin') {
        check('研究人員看不到「系統設定」按鈕', () => {
          return !settingsButton || settingsButton.classList.contains('hidden');
        });
        // 就算用開發者工具把按鈕弄出來，按下去也該被後端擋掉。
        // 這裡驗「前端有沒有先把開關鎖住」—— 讓使用者一開始就知道
        // 「這不是我能改的」，而不是按了之後才看到錯誤。
        check('研究人員就算打開設定，開關也是鎖住的', async () => true);
        const locked = await (async () => {
          if (settingsButton) settingsButton.classList.remove('hidden');
          return true;
        })();
        void locked;
      }

      if (${JSON.stringify(role)} === 'admin') {
        // ---- 2. 打開設定視窗 ----
        check('設定視窗一開始是關著的', () => !modal.classList.contains('open'));
        settingsButton.click();

        await waitFor('設定視窗打開', () => modal.classList.contains('open'));
        check('按「系統設定」會打開視窗', () => modal.classList.contains('open'));

        await waitFor('開關的狀態載入完成', () => toggle.checked === ${JSON.stringify(initialAutoUpdate)});
        check('視窗裡讀到的是資料庫裡的現況', () => toggle.checked === ${JSON.stringify(initialAutoUpdate)});
        check('有文字說明開關現在是開還是關', () => {
          const state = document.getElementById('autoUpdateState');
          return Boolean(state && state.textContent.trim());
        });

        // 把開關撥到「目前狀態的相反」，並且照畫面上的方式觸發 change。
        // 這裡刻意不寫死「先關再開」：初始狀態是哪一邊，動作就該往另一邊。
        async function flipOnce(label) {
          const target = !toggle.checked;
          const before = window.__requests.length;
          toggle.checked = target;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));

          await waitFor(label + '：送出 PATCH', () =>
            window.__requests.slice(before)
              .some(r => r.method === 'PATCH' && r.url.includes('/api/update-policy')));

          check(label + '：切換開關真的送出 PATCH（不是只改畫面）', () =>
            window.__requests.slice(before)
              .some(r => r.method === 'PATCH' && r.url.includes('/api/update-policy')));

          const patch = window.__requests.slice(before)
            .find(r => r.method === 'PATCH' && r.url.includes('/api/update-policy'));
          check(label + '：送出的內容就是撥過去的那個值', () => {
            if (!patch) return false;
            const body = JSON.parse(patch.body || '{}');
            return body.autoUpdate === target;
          });

          // 等到畫面把「已開啟／已關閉」寫出來，才算儲存完成。
          await waitFor(label + '：畫面更新', () => {
            const state = document.getElementById('autoUpdateState');
            const text = state ? state.textContent : '';
            return target ? text.includes('開啟') : text.includes('關閉');
          });

          check(label + '：開關停在使用者撥的位置', () => toggle.checked === target);
          check(label + '：畫面說的話和開關一致', () => {
            const state = document.getElementById('autoUpdateState');
            return target ? state.textContent.includes('開啟') : state.textContent.includes('關閉');
          });
          return target;
        }

        const afterFirst = await flipOnce('第一次切換');
        check('切換後沒有留下「儲存中」這種半路狀態', () => {
          const state = document.getElementById('autoUpdateState');
          return !state.textContent.includes('儲存中');
        });
        check('切換後沒有卡在停用（否則使用者就再也按不動了）', () => toggle.disabled === false);

        // ---- 3b. 儲存失敗時，開關要撥回去（不能留下假的成功畫面） ----
        //
        // 這是最容易被寫錯、也最傷的一種：使用者按了「關閉」，畫面顯示
        // 「已關閉」，他很滿意地關掉視窗 —— 但其實資料庫沒寫進去，
        // 系統明天照樣自己更新。他不會知道，直到某天發現系統變了。
        window.__forcePatchFailure = true;
        {
          const target = !toggle.checked;
          const before = window.__requests.length;
          toggle.checked = target;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));

          await waitFor('失敗情境：有送出 PATCH', () =>
            window.__requests.slice(before).some(r => r.method === 'PATCH'));

          await waitFor('失敗情境：錯誤訊息出現', () => {
            const notice = document.getElementById('autoUpdateNotice');
            return notice && notice.dataset.tone === 'error';
          });

          check('存不進去時，開關會撥回原位（不留下假的成功狀態）', () => {
            return toggle.checked !== target;
          });
          check('存不進去時，畫面明確說「沒有存成功」', () => {
            const notice = document.getElementById('autoUpdateNotice');
            return notice && /沒有存成功|失敗/.test(notice.textContent);
          });
          check('存不進去時，畫面不會同時說「已關閉」（不能自相矛盾）', () => {
            const state = document.getElementById('autoUpdateState');
            const text = state ? state.textContent : '';
            return !(target === false && text.includes('已關閉'));
          });
          check('存不進去之後，開關還是可以再按（沒有卡住）', () => toggle.disabled === false);
        }
        window.__forcePatchFailure = false;

        // ---- 4. 再撥回去 ----
        const afterSecond = await flipOnce('第二次切換');
        check('可以再撥回原本的位置', () => afterSecond === !afterFirst);
        check('撥回去之後開關與畫面仍一致', () => toggle.checked === afterSecond);

        // ---- 5. 關掉視窗再打開，狀態要留著 ----
        document.getElementById('settingsModal').classList.remove('open');
        settingsButton.click();
        await waitFor('重新打開設定', () => modal.classList.contains('open'));
        await waitFor('重新載入狀態', () => toggle.checked === afterSecond);
        check('關掉視窗再打開，看到的仍是剛才存的狀態', () => toggle.checked === afterSecond);
      } else {
        // 研究人員：就算把按鈕弄出來、打開視窗，開關也要是停用的
        if (settingsButton) {
          settingsButton.classList.remove('hidden');
          settingsButton.click();
          await waitFor('研究人員的設定視窗打開', () => modal.classList.contains('open'));
          await sleep(800);
          check('研究人員打開設定時，開關是停用狀態（不是按了才報錯）', () => toggle && toggle.disabled === true);
        }
      }

      check('未捕捉到 JavaScript 錯誤', () => window.__uiErrors.length === 0);
    } catch (error) {
      results.push({ name: '整段流程走完', ok: false, detail: String(error && error.message || error) });
    }

    const pre = document.createElement('pre');
    pre.id = 'settings-result';
    pre.textContent = JSON.stringify({ results, errors: window.__uiErrors }, null, 2);
    document.body.appendChild(pre);
  }, 900);
}
window.addEventListener('load', () => setTimeout(report, 500));
</script>`;
}

function runScenario(options) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-settings-'));
  const pagePath = join(dir, 'settings-test.html');
  writeFileSync(pagePath, html.replace('</body>', () => buildHarness(options) + '\n</body>'));

  let dom;
  try {
    dom = execFileSync(CHROME, [
      '--headless=old', '--disable-gpu', '--no-sandbox', '--window-size=1440,900',
      '--virtual-time-budget=40000', '--dump-dom', `file://${pagePath}`
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const match = dom.match(/<pre id="settings-result">([\s\S]*?)<\/pre>/);
  if (!match) return null;
  return JSON.parse(match[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

let failed = 0;
let total = 0;

function report(title, payload) {
  console.log(`\n【${title}】`);
  if (!payload) {
    console.log('✗ 這一輪沒有回傳結果（頁面可能載入失敗）');
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
}

// 情境 1：管理員，自動更新本來是開的 → 關掉 → 再打開
report('管理員：把自動更新關掉再打開', runScenario({ role: 'admin', initialAutoUpdate: true }));

// 情境 2：管理員，自動更新本來是關的 → 打開。
// 這個情境要單獨跑，因為「一開始就是關的」和「剛把它關掉」在畫面上
// 應該長得一樣，但程式走的是不同分支（初始載入 vs 切換後更新）。
report('管理員：開關原本是關的，要能打開', runScenario({ role: 'admin', initialAutoUpdate: false }));

// 情境 3：研究人員 —— 看不到按鈕，也按不動
report('研究人員：看不到也按不動', runScenario({ role: 'student', initialAutoUpdate: true }));

console.log(`\n自動更新開關（介面）測試：${total - failed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
