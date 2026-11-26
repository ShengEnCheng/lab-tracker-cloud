// 「介面上關掉自動更新」這個開關，真的會讓自動更新停下來嗎？
//
// 為什麼這支測試非有不可：
//   這個功能的失敗方式是**靜默的**。研究室在介面上按了「關閉自動更新」，
//   畫面顯示「已關閉」、看起來一切正常，但如果 Action 那邊沒有真的去問，
//   系統隔天照樣被改掉。使用者不會收到任何錯誤訊息，他只會在某天發現
//   系統「自己變了」—— 而那正是他按鈕想避免的事。
//
//   反過來也一樣糟：如果查詢邏輯寫錯（例如把「讀不到」當成「關掉了」），
//   所有研究室會在某次網路抖動後永久停止更新，而且畫面上完全看不出來。
//
// 所以這裡驗四件事：
//   1. 開關是「關」的時候，更新腳本真的一個檔案都不動。
//   2. 開關是「開」的時候，更新照常發生（不能因為加了檢查就壞掉）。
//   3. 查不到網站的時候要「放行」，不是「停止」。
//   4. 這個決定真的存在資料庫裡，不是只存在某個人的瀏覽器裡。

import { createServer } from 'node:http';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSupabase } from './mock-supabase.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const failures = [];
let passed = 0;

function check(label, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`✔ ${label}${detail && detail !== true ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`✘ ${label} — ${error.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`✔ ${label}${detail && detail !== true ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`✘ ${label} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.vercel', '.update-temp']);
const SKIP_FILES = /\.log$|\.DS_Store$/;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim();
}

function gitAvailable() {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function copyProjectFiles(dir) {
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: source => {
      const name = source.split('/').pop();
      if (SKIP_DIRECTORIES.has(name)) return false;
      if (SKIP_FILES.test(name)) return false;
      return true;
    }
  });
}

function setVersion(dir, version) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const infoPath = join(dir, 'src/lib/app-info.js');
  const info = readFileSync(infoPath, 'utf8')
    .replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${version}';`);
  writeFileSync(infoPath, info);
}

function readVersion(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
}

function makeRepo(dir, message) {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Lab PI']);
  git(dir, ['config', 'user.email', 'pi@lab.example.edu']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function makeTemplateRepo(dir, { version = '1.0.0' } = {}) {
  mkdirSync(dir, { recursive: true });
  copyProjectFiles(dir);
  setVersion(dir, version);
  makeRepo(dir, `release ${version}`);
  return dir;
}

function makeLabRepo(dir, { origin, version = '1.0.0' }) {
  mkdirSync(dir, { recursive: true });
  copyProjectFiles(dir);
  setVersion(dir, version);
  makeRepo(dir, 'Initial commit from Vercel template');
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

function makeBareOrigin(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '--bare', '-b', 'main']);
  return dir;
}

// 跑更新腳本。env 可以用來餵 LAB_SITE_URL。
//
// 必須用非同步的 spawn，不能用 execFileSync：腳本會用 curl 去問
// 「假的研究室網站」，而那個假網站就跑在同一支測試程式裡。
// execFileSync 會把整個事件迴圈鎖住，假網站永遠回應不了 ——
// 於是「腳本沒有發出請求」這種假失敗就出現了（實際上有發，只是沒人接）。
async function runUpdate(labDir, args = [], env = {}) {
  return new Promise(resolve => {
    const child = spawn('bash', [join(labDir, 'scripts/apply-template-update.sh'), ...args], {
      cwd: labDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr }));
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

function treeState(dir) {
  // 檔案的「指紋」：路徑 + 大小 + mtime。用來證明「一個檔案都沒動」。
  const out = execFileSync('bash', ['-c', 'find . -type f -not -path "./.git/*" -print0 | sort -z | xargs -0 stat -f "%N %z %m" 2>/dev/null || true'], {
    cwd: dir, encoding: 'utf8'
  });
  return out.trim();
}

const hasGit = gitAvailable();

if (!hasGit) {
  console.log('（這台機器沒有 git，跳過自動更新的測試）');
  process.exit(0);
}

const workRoot = mkdtempSync(join(tmpdir(), 'lab-policy-'));

// ---------------------------------------------------------------------------
// 起一個假的「研究室網站」，只回答 /api/update-policy。
//
// 為什麼要真的起一個 HTTP server：更新腳本是用 curl 去問網站的，
// 若改成讀檔案或環境變數，就測不到「腳本真的會發出請求、也真的看得懂回應」。
// ---------------------------------------------------------------------------
function startFakeSite({ autoUpdate = true, schemaReady = true, ignoreQuery = false } = {}) {
  const state = { hits: 0, autoUpdate, schemaReady };
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/api/update-policy')) {
      res.statusCode = 404;
      return res.end('not found');
    }
    state.hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      version: '1.1.0',
      autoUpdate: state.autoUpdate,
      schemaReady: state.schemaReady,
      backendConfigured: true,
      siteUrl: 'http://127.0.0.1'
    }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

try {
  // =========================================================================
  console.log('\n【1. 開關關掉時，更新腳本真的一個檔案都不動】');
  // =========================================================================
  {
    const template = makeTemplateRepo(join(workRoot, 'tpl-off'), { version: '1.0.0' });
    // 範本推到 1.1.0，這樣「有更新可拿」是確定的。
    writeFileSync(join(template, 'NEW-FILE-off.txt'), 'from template 1.1.0\n');
    setVersion(template, '1.1.0');
    git(template, ['add', '-A']);
    git(template, ['commit', '-q', '-m', 'release 1.1.0']);

    const origin = makeBareOrigin(join(workRoot, 'origin-off.git'));
    const lab = makeLabRepo(join(workRoot, 'lab-off'), { origin, version: '1.0.0' });
    git(lab, ['push', '-q', 'origin', 'main']);

    const site = await startFakeSite({ autoUpdate: false });
    const before = treeState(lab);
    const beforeHead = git(lab, ['rev-parse', 'HEAD']);

    const result = await runUpdate(lab, ['--upstream', template], { LAB_SITE_URL: site.url });

    await checkAsync('腳本有去問網站的開關', async () => {
      assert(site.state.hits > 0, '腳本完全沒有發出請求，代表它根本沒在檢查開關');
      return `問了 ${site.state.hits} 次`;
    });

    check('關掉時結束碼是 0（不是錯誤）', () => {
      assert(result.code === 0, `結束碼是 ${result.code}，stderr=${result.stderr}`);
      return true;
    });

    check('關掉時版號沒變', () => {
      const now = readVersion(lab);
      assert(now === '1.0.0', `版號變成 ${now}，代表更新還是跑了`);
      return `仍是 ${now}`;
    });

    check('關掉時一個檔案都沒被動到（連 mtime 都一樣）', () => {
      const after = treeState(lab);
      assert(before === after, '工作區的檔案有變動');
      return true;
    });

    check('關掉時 HEAD 沒有移動、也沒有多出 commit', () => {
      const afterHead = git(lab, ['rev-parse', 'HEAD']);
      assert(afterHead === beforeHead, 'HEAD 移動了');
      return true;
    });

    check('關掉時輸出有說明白話「不做任何事」', () => {
      assert(/關閉自動更新/.test(result.stdout), `輸出沒有提到關閉：${result.stdout}`);
      return true;
    });

    await site.close();
  }

  // =========================================================================
  console.log('\n【2. 開關是開的（或沒設定）時，更新照常發生】');
  // =========================================================================
  {
    const template = makeTemplateRepo(join(workRoot, 'tpl-on'), { version: '1.0.0' });
    writeFileSync(join(template, 'NEW-FILE-on.txt'), 'from template 1.1.0\n');
    setVersion(template, '1.1.0');
    git(template, ['add', '-A']);
    git(template, ['commit', '-q', '-m', 'release 1.1.0']);

    const origin = makeBareOrigin(join(workRoot, 'origin-on.git'));
    const lab = makeLabRepo(join(workRoot, 'lab-on'), { origin, version: '1.0.0' });
    git(lab, ['push', '-q', 'origin', 'main']);

    const site = await startFakeSite({ autoUpdate: true });
    const result = await runUpdate(lab, ['--upstream', template, '--force'], { LAB_SITE_URL: site.url });

    await checkAsync('開關是開的時候，腳本確實去問了', async () => {
      assert(site.state.hits > 0, '沒有發出請求');
      return true;
    });

    check('開著時版號有更新到 1.1.0', () => {
      const now = readVersion(lab);
      assert(now === '1.1.0', `版號是 ${now}，更新沒有發生`);
      return `版本 ${now}`;
    });

    check('開著時新檔案真的出現了', () => {
      assert(existsSync(join(lab, 'NEW-FILE-on.txt')), '範本的新檔案沒有出現在研究室副本裡');
      return true;
    });

    check('開著時結束碼 0', () => {
      assert(result.code === 0, `結束碼 ${result.code}: ${result.stderr}`);
      return true;
    });

    await site.close();
  }

  // =========================================================================
  console.log('\n【3. 查不到網站時要「放行」，不是「停止」】');
  // =========================================================================
  {
    // 這是整個設計最關鍵的取捨。
    //
    // 既有已部署的研究室沒有設定 LAB_SITE_URL。如果把「查不到」當成
    // 「關掉了」，他們會在完全沒有感覺的情況下永久停止收到修正 ——
    // 而且畫面上不會有任何提示。反過來，把「查不到」當成「開著」，
    // 最壞情況只是多更新一次（更新本身是安全的：不碰資料）。
    //
    // 兩害相權，必須選「放行」。
    const template = makeTemplateRepo(join(workRoot, 'tpl-unknown'), { version: '1.0.0' });
    writeFileSync(join(template, 'NEW-FILE-unknown.txt'), 'from template\n');
    setVersion(template, '1.1.0');
    git(template, ['add', '-A']);
    git(template, ['commit', '-q', '-m', 'release 1.1.0']);

    const origin = makeBareOrigin(join(workRoot, 'origin-unknown.git'));
    const lab = makeLabRepo(join(workRoot, 'lab-unknown'), { origin, version: '1.0.0' });
    git(lab, ['push', '-q', 'origin', 'main']);

    // 指向一個確定沒有人在聽的 port。
    const result = await runUpdate(lab, ['--upstream', template, '--force'], {
      LAB_SITE_URL: 'http://127.0.0.1:1'
    });

    check('連不到網站時仍然照常更新（不會被誤判成關掉）', () => {
      const now = readVersion(lab);
      assert(now === '1.1.0', `版號停在 ${now}，代表「查不到」被誤判成「關掉了」`);
      return `更新到 ${now}`;
    });

    check('連不到網站時輸出要說明「照常更新」與原因', () => {
      assert(/照常更新|略過/.test(result.stdout), `輸出沒有交代：${result.stdout}`);
      return true;
    });
  }

  // =========================================================================
  console.log('\n【4. 這個決定存在資料庫裡，不是只存在瀏覽器裡】');
  // =========================================================================
  const mock = await startMockSupabase();
  mock.applyEnv(process.env);

  // 直接載入端點模組，模擬 Vercel 的請求。
  const policyModule = (await import('../api/update-policy.js')).default;

  function callPolicy({ method = 'GET', body = null, token = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = {
        method,
        url: '/api/update-policy',
        headers: {
          host: 'lab.example.edu',
          'x-forwarded-proto': 'https',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        async *[Symbol.asyncIterator]() {
          if (body) yield Buffer.from(JSON.stringify(body));
        }
      };
      const chunks = [];
      const res = {
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString('utf8');
          let payload = null;
          try { payload = JSON.parse(text); } catch { payload = text; }
          resolve({ status: this.statusCode, body: payload, headers: this.headers });
        }
      };
      Promise.resolve(policyModule(req, res)).catch(reject);
    });
  }

  // 建立一個管理員與一個研究人員，用來驗證權限。
  //
  // 直接用 mock.state 而不是包一層 helper：mock 就是記憶體裡的假資料庫，
  // 塞值進去等於「資料庫裡本來就有這些列」。
  const adminUser = { id: crypto.randomUUID(), email: 'admin@lab.example.edu' };
  const studentUser = { id: crypto.randomUUID(), email: 'student@lab.example.edu' };

  mock.state.tables.lab_profiles.push(
    { id: adminUser.id, email: adminUser.email, role: 'admin', active: true, display_name: '管理者' },
    { id: studentUser.id, email: studentUser.email, role: 'researcher', active: true, display_name: '研究生' }
  );
  mock.state.tables.lab_settings.push({
    id: 1,
    organization_name: '測試研究室',
    setup_completed_at: new Date().toISOString(),
    auto_update_enabled: true
  });

  // 把 token 登記成「真的登入過的人」。真實 Supabase 靠 JWT 簽章判斷，
  // 這裡用白名單模擬同一件事（見 mock-supabase.mjs 的說明）。
  mock.state.authTokens.push(`token-${adminUser.id}`, `token-${studentUser.id}`);

  await checkAsync('還沒登入時讀得到開關（Actions 不會帶使用者 token）', async () => {
    const response = await callPolicy();
    assert(response.status === 200, `狀態 ${response.status}`);
    assert(response.body.autoUpdate === true, `回傳 ${JSON.stringify(response.body)}`);
    return `autoUpdate=${response.body.autoUpdate}`;
  });

  await checkAsync('開關的讀取不需要任何 Authorization 標頭', async () => {
    const response = await callPolicy();
    assert(response.status === 200, `狀態 ${response.status}`);
    assert(response.body && typeof response.body.autoUpdate === 'boolean', '沒有回傳布林值');
    return true;
  });

  await checkAsync('網站會告訴 Action「我是哪個網址」（否則 Action 查不到）', async () => {
    const response = await callPolicy();
    assert(response.body.siteUrl === 'https://lab.example.edu', `siteUrl=${response.body.siteUrl}`);
    return response.body.siteUrl;
  });

  await checkAsync('管理員可以把自動更新關掉', async () => {
    const response = await callPolicy({
      method: 'PATCH',
      token: `token-${adminUser.id}`,
      body: { autoUpdate: false }
    });
    assert(response.status === 200, `狀態 ${response.status}: ${JSON.stringify(response.body)}`);
    assert(response.body.autoUpdate === false, `回傳 ${JSON.stringify(response.body)}`);
    return true;
  });

  await checkAsync('關掉之後，公開讀取也回「關」—— 這才是真的存在資料庫裡', async () => {
    // 這是關鍵斷言：如果實作只是把狀態存在記憶體或 localStorage，
    // 這裡就會回 true，代表 Action 讀到的永遠是「開」。
    const response = await callPolicy();
    assert(response.body.autoUpdate === false, `公開讀取回的是 ${response.body.autoUpdate}`);
    return '資料庫裡的狀態改變了';
  });

  await checkAsync('管理員可以把自動更新再打開', async () => {
    const response = await callPolicy({
      method: 'PATCH',
      token: `token-${adminUser.id}`,
      body: { autoUpdate: true }
    });
    assert(response.status === 200, `狀態 ${response.status}`);
    const readBack = await callPolicy();
    assert(readBack.body.autoUpdate === true, `讀回來是 ${readBack.body.autoUpdate}`);
    return true;
  });

  await checkAsync('非管理員不能改（研究人員會被擋）', async () => {
    const response = await callPolicy({
      method: 'PATCH',
      token: `token-${studentUser.id}`,
      body: { autoUpdate: false }
    });
    assert(response.status === 403, `狀態是 ${response.status}，應該被拒絕`);
    // 而且真的沒改到。
    const readBack = await callPolicy();
    assert(readBack.body.autoUpdate === true, '被拒絕的請求竟然改到了資料');
    return true;
  });

  await checkAsync('沒帶 token 不能改', async () => {
    const response = await callPolicy({ method: 'PATCH', body: { autoUpdate: false } });
    assert(response.status === 401, `狀態是 ${response.status}`);
    return true;
  });

  await checkAsync('假 token 不能改', async () => {
    const response = await callPolicy({ method: 'PATCH', token: 'fake-token-abc', body: { autoUpdate: false } });
    assert(response.status === 401, `狀態是 ${response.status}`);
    return true;
  });

  await checkAsync('亂傳值會被擋（不是布林就要 422）', async () => {
    const response = await callPolicy({
      method: 'PATCH',
      token: `token-${adminUser.id}`,
      body: { autoUpdate: 'no' }
    });
    assert(response.status === 422, `狀態是 ${response.status}`);
    return true;
  });

  // 「讀不到」有兩種，要分開驗，因為它們走的是程式裡不同的分支：
  //   1. 資料庫回了 503（專案被暫停）→ response.ok 是 false
  //   2. 根本連不上（網路斷、DNS 掛、timeout）→ fetch 直接丟錯，走 catch
  // 只驗一種，另一種就可能默默變成「關掉」，而那正是最危險的失敗方式：
  // 所有研究室在某次網路抖動後永久停止更新，畫面上完全看不出來。
  await checkAsync('資料庫回 503（被暫停）時，回「開」', async () => {
    mock.state.down = true;
    try {
      const response = await callPolicy();
      assert(response.status === 200, `狀態 ${response.status}`);
      assert(response.body.autoUpdate === true, `回傳 ${JSON.stringify(response.body)}，會讓所有研究室永久停止更新`);
      return '503 也要當成沒關';
    } finally {
      mock.state.down = false;
    }
  });

  await checkAsync('資料庫根本連不上（fetch 丟錯）時，也回「開」', async () => {
    // 把環境變數指到一個確定沒有人在聽的 port，模擬網路層失敗。
    // 這條路走的是 readPolicy 的 catch 分支，和上面的 503 是不同的程式路徑。
    const savedUrl = process.env.SUPABASE_URL;
    const savedPublishable = process.env.SUPABASE_PUBLISHABLE_KEY;
    const savedSecret = process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_URL = 'http://127.0.0.1:1';
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_key';
    try {
      const response = await callPolicy();
      assert(response.status === 200, `狀態 ${response.status}`);
      assert(response.body.autoUpdate === true,
        `連不上時回 ${JSON.stringify(response.body)} —— 這會讓一次網路故障變成永久停止更新`);
      return '連不上也要當成沒關';
    } finally {
      process.env.SUPABASE_URL = savedUrl;
      process.env.SUPABASE_PUBLISHABLE_KEY = savedPublishable;
      process.env.SUPABASE_SECRET_KEY = savedSecret;
    }
  });

  await mock.close();
} catch (error) {
  failures.push({ label: '測試本身出錯', error });
  console.log(`✘ 測試本身出錯 — ${error.message}`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.log(`自動更新開關測試：${passed} 通過，${failures.length} 失敗`);
  for (const failure of failures) {
    console.log(`  · ${failure.label}: ${failure.error.message}`);
  }
  process.exit(1);
}
console.log(`自動更新開關測試：${passed} 通過，0 失敗`);
