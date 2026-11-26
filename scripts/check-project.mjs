// 專案結構檢查：確認交付出去的東西是完整的、沒有半成品。
//
// 這支會在 CI 與 `npm run release` 之前跑。它故意做很笨的事 ——
// 檢查檔案在不在、語法對不對、有沒有把機密寫進程式碼 —— 因為這些
// 錯誤一旦交付出去，研究室那邊是無法自己修的。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const failures = [];
const notes = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) failures.push(name);
    else console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push(`${name}（${error.message}）`);
    console.log(`  ✘ ${name}：${error.message}`);
  }
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

// ---------------------------------------------------------------------------
console.log('\n1. 必要檔案');
const REQUIRED_FILES = [
  'package.json',
  'vercel.json',
  'index.html',
  '.env.example',
  '.gitignore',
  'README.md',
  // 後端
  'api/_supabase.js',
  'api/config.js',
  'api/health.js',
  'api/setup.js',
  'api/setup-status.js',
  'api/data.js',
  'api/profiles.js',
  'api/import.js',
  'api/backups.js',
  'api/restore.js',
  'api/backup.js',
  // 函式庫
  'src/lib/app-info.js',
  'src/lib/initial-state.js',
  'src/lib/setup-validation.js',
  // 資料庫
  'supabase/migrations/001_lab_state.sql',
  'supabase/migrations/002_lab_settings.sql',
  'supabase/migrations/003_update_policy.sql',
  // 工具
  'scripts/dev-server.mjs',
  'scripts/verify-sql.mjs',
  // 引導網頁
  'wizard/index.html',
  // 文件
  'docs/installation.md',
  'docs/handover.md',
  // 測試
  'tests/unit.test.mjs',
  'tests/integration.test.mjs',
  'tests/ui.test.mjs',
  'tests/session-flow.test.mjs',
  'tests/handoff-flow.test.mjs',
  'tests/roster.test.mjs',
  'tests/export-completeness.test.mjs',
  'tests/user-export-import.test.mjs',
  'tests/import-button.test.mjs',
  'tests/update-path.test.mjs',
  'tests/auto-update.test.mjs',
  'tests/auto-update-policy.test.mjs',
  'tests/auto-update-settings-ui.test.mjs',
  'tests/feature-checkup.test.mjs',
  'tests/wizard-journey.test.mjs',
  'tests/wizard.test.mjs',
  'tests/mock-supabase.mjs'
];
for (const file of REQUIRED_FILES) {
  check(file, () => exists(file));
}

// ---------------------------------------------------------------------------
console.log('\n2. 沒有寫死別人的基礎設施');
// 這是這個專案最重要的檢查：範本被複製出去時，如果還留著作者的網址或金鑰，
// 研究室會默默連到別人的資料庫 —— 他們不會發現，資料也不會是他們的。
const LEAK_PATTERNS = [
  [/bhgitdpvhjjgkasilniy/i, '作者原本的 Supabase 專案網址'],
  [/[a-z0-9]{20}\.supabase\.co/i, '寫死的 Supabase 網址'],
  [/eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_-]{10}/, '疑似寫死的 JWT 金鑰'],
  [/sb_publishable_[A-Za-z0-9_-]{20,}/, '疑似寫死的 publishable 金鑰'],
  [/sb_secret_[A-Za-z0-9_-]{20,}/, '疑似寫死的 secret 金鑰'],
  [/sbp_[A-Za-z0-9]{20,}/, '疑似寫死的存取權杖']
];
function scanForLeaks() {
  const targets = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.update-temp'].includes(entry.name)) continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|mjs|html|json|sql|md|example)$/.test(entry.name)) {
        // 跳過這支檢查程式自己：比對用的樣式字串本身就長得像洩漏
        if (rel === path.join('.', 'scripts', 'check-project.mjs')) continue;
        if (rel === path.join('scripts', 'check-project.mjs')) continue;
        targets.push(rel);
      }
    }
  };
  walk('.');

  const found = [];
  for (const rel of targets) {
    const text = read(rel);
    for (const [pattern, label] of LEAK_PATTERNS) {
      if (pattern.test(text)) found.push(`${rel}：${label}`);
    }
  }
  if (found.length) throw new Error(found.join('；'));
  return true;
}
check('沒有寫死的 Supabase 網址或金鑰', scanForLeaks);

// ---------------------------------------------------------------------------
console.log('\n3. 沒有寫死的預設密碼');
// 原本的專案在建立成員時，若沒帶密碼就用一個固定字串 —— 那等於
// 每個部署都有一組公開的萬用密碼。
check('api/profiles.js 沒有固定預設密碼', () => {
  const text = read('api/profiles.js');
  if (/password\s*[:=]\s*body\.password\s*\|\|\s*['"][^'"]+['"]/.test(text)) {
    throw new Error('仍有 `body.password || "固定字串"` 的寫法');
  }
  if (!text.includes('generateTemporaryPassword')) {
    throw new Error('沒有使用隨機密碼產生器');
  }
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n4. JavaScript 語法');
const JS_TARGETS = [];
for (const dir of ['api', 'src', 'scripts', 'tests']) {
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (/\.(js|mjs)$/.test(entry.name)) JS_TARGETS.push(next);
    }
  };
  if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
}
for (const file of JS_TARGETS) {
  check(file, () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    return true;
  });
}

// ---------------------------------------------------------------------------
console.log('\n5. index.html 的內嵌程式');
check('index.html 內嵌 JS 語法正確', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  if (!scripts.length) throw new Error('找不到內嵌 script');
  const main = scripts[scripts.length - 1];
  const temp = path.join(ROOT, '.syntax-check.js');
  fs.writeFileSync(temp, main);
  try {
    execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(temp);
  }
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n6. 沒有舊品牌殘留');
// 掃所有會被複製出去的研究室看到的檔案，不只 index.html。
//
// 為什麼要掃全部：原本只檢查 index.html，結果下載檔名裡的 `zheng-lab-…`
// 和引導網頁裡的「例如 zheng-lab」都活得好好的。這是範本 repo，
// 留下作者的名字或帳號，別人複製後會看到不屬於自己的東西。
check('所有交付檔案都沒有舊品牌殘留', () => {
  const SCAN = [
    'index.html',
    'api', 'src', 'wizard', 'scripts',
    'docs', 'README.md', 'supabase'
  ];
  // 這個檢查檔自己會提到那些字（就是上面的說明與正則），跳過它。
  const SELF = 'scripts/check-project.mjs';
  // 允許保留的例外：舊版相容清單（那是刻意的，不是殘留）
  const ALLOWED = [
    /acceptedServiceNames/,          // 相容舊部署的健康檢查名稱
    /'zheng-lab-api'/                // 同上
  ];
  const problems = [];

  const walk = (rel) => {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(path.join(rel, entry.name));
      }
      return;
    }
    if (rel === SELF) return;
    if (!/\.(js|mjs|html|css|sql|md|json)$/.test(rel)) return;
    const text = fs.readFileSync(full, 'utf8');
    for (const line of text.split('\n')) {
      if (ALLOWED.some(pattern => pattern.test(line))) continue;
      if (/鄭|ZHENG_LAB|__ZHENG_LAB_|zheng-lab/.test(line)) {
        problems.push(`${rel}: ${line.trim().slice(0, 80)}`);
      }
    }
  };

  for (const entry of SCAN) walk(entry);
  if (problems.length) throw new Error(problems.slice(0, 5).join('；'));
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n7. 版號只有一個來源');
// 版號寫死在多處的話，更新之後設定頁會顯示舊版號，
// 維護者就無法判斷研究室真正在跑哪一版。
check('版號只定義在 src/lib/app-info.js', () => {
  const offenders = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      if (next.endsWith('src/lib/app-info.js')) continue;
      if (next.includes('tests')) continue;
      const text = read(next);
      const matches = text.match(/(?:version|Version)\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/g);
      if (matches) offenders.push(`${next}：${matches[0]}`);
    }
  };
  for (const dir of ['api', 'src', 'scripts']) walk(dir);
  if (offenders.length) throw new Error(offenders.join('；'));
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n8. package.json 與 app-info.js 版號一致');
check('package.json 與 app-info.js 版號相同', () => {
  const pkg = JSON.parse(read('package.json'));
  const appInfo = read('src/lib/app-info.js');
  const match = appInfo.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('app-info.js 找不到 APP_VERSION');
  if (pkg.version !== match[1]) throw new Error(`package.json 是 ${pkg.version}，app-info.js 是 ${match[1]}`);
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n9. 零 npm 依賴');
check('package.json 沒有 dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  if (deps.length) throw new Error(`有依賴：${deps.join('、')}（研究室部署不該需要 npm install）`);
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n10. 資料庫 migration 的保護');
check('001 建立主要資料表', () => {
  const sql = read('supabase/migrations/001_lab_state.sql');
  for (const table of ['lab_profiles', 'lab_state', 'lab_audit_logs', 'lab_backups']) {
    if (!sql.includes(table)) throw new Error(`找不到 ${table}`);
  }
  if (!/enable row level security/i.test(sql)) throw new Error('沒有啟用 RLS');
  return true;
});
check('002 建立研究室設定表且沒有開放 insert', () => {
  const sql = read('supabase/migrations/002_lab_settings.sql');
  if (!sql.includes('lab_settings')) throw new Error('找不到 lab_settings');
  if (/create policy[\s\S]*?for insert/i.test(sql)) {
    throw new Error('不該有 insert 政策：第一列只能由伺服器 secret 金鑰建立，否則任何人可搶先設定');
  }
  return true;
});
check('003 加上自動更新開關欄位，且預設是開的', () => {
  const sql = read('supabase/migrations/003_update_policy.sql');
  if (!/add column if not exists\s+auto_update_enabled\s+boolean\s+not null\s+default true/i.test(sql)) {
    throw new Error('沒有一個預設為 true 的 auto_update_enabled 欄位');
  }
  // 必須是 if not exists：研究室可能按兩次 RUN，重跑不能爆。
  if (!/add column if not exists/i.test(sql)) {
    throw new Error('alter table 必須用 add column if not exists，重複執行才不會失敗');
  }
  return true;
});

// 「介面上關掉自動更新」是跨三個地方的約定：介面寫進資料庫、API 讀出來、
// Action 去問 API。任何一環斷掉都不會有錯誤訊息 —— 開關看起來能按，
// 但自動更新照樣發生。這種壞法只能靠結構檢查守住。
check('自動更新開關的三段約定都在（介面／API／Action）', () => {
  const api = read('api/update-policy.js');
  if (!/auto_update_enabled/.test(api)) {
    throw new Error('api/update-policy.js 沒有讀寫 auto_update_enabled');
  }
  // API 的 GET 必須免登入：GitHub Actions 從 github.com 打過來，不帶使用者 token。
  if (!/req\.method === 'GET'/.test(api)) {
    throw new Error('api/update-policy.js 沒有處理 GET');
  }
  const open = read('api/_supabase.js');
  if (!/update-policy/.test(open)) {
    throw new Error('update-policy 不在 CORS 開放清單裡，Actions 會被 CORS 擋掉');
  }
  const script = read('scripts/apply-template-update.sh');
  if (!/api\/update-policy/.test(script)) {
    throw new Error('更新腳本沒有去問 /api/update-policy，開關不會生效');
  }
  if (!/autoUpdate/.test(script)) {
    throw new Error('更新腳本沒有讀 autoUpdate 欄位');
  }
  const ui = read('index.html');
  if (!/id="autoUpdateToggle"/.test(ui)) {
    throw new Error('介面上沒有自動更新的開關');
  }
  return true;
});

check('更新腳本在「任何 git 動作之前」就檢查開關', () => {
  const script = read('scripts/apply-template-update.sh');
  const lines = script.split('\n');

  // 只看「真的會被執行到的指令」：
  //   · 跳過註解與空行
  //   · 跳過函式定義的內容（commit_as_author() 裡有 git commit，
  //     那是「以後會被呼叫的東西」，不是現在就執行的動作）
  const inFunction = lines.map(() => false);
  let openFunction = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!openFunction && /^[a-z_]+\s*\(\)\s*\{/.test(lines[i])) openFunction = true;
    inFunction[i] = openFunction;
    if (openFunction && lines[i] === '}') openFunction = false;
  }

  const isExecutable = index => {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    if (inFunction[index]) return false;
    return true;
  };
  const firstIndexOf = predicate => {
    for (let i = 0; i < lines.length; i += 1) {
      if (!isExecutable(i)) continue;
      if (predicate(lines[i])) return i;
    }
    return -1;
  };

  const policyIndex = firstIndexOf(line => line.includes('api/update-policy'));
  if (policyIndex === -1) throw new Error('腳本沒有檢查開關');

  // 關掉的意思是「什麼都不要動」。如果先 fetch 或先改檔案才檢查，
  // 資料夾已經被動過了，之後再 exit 也回不去。
  const firstMutation = firstIndexOf(line =>
    /git\s+(fetch|reset|commit|push|checkout|clean)/.test(line)
    || /^commit_as_author\s+["']/.test(line.trim())
  );
  if (firstMutation !== -1 && firstMutation < policyIndex) {
    throw new Error(
      `檢查開關在第 ${policyIndex + 1} 行，但第 ${firstMutation + 1} 行就已經有 git 動作了 —— `
      + '關掉時工作區會被改過'
    );
  }
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n11. .gitignore 擋住機密檔');
check('.gitignore 忽略 .env.local', () => {
  const text = read('.gitignore');
  if (!text.includes('.env')) throw new Error('沒有忽略 .env');
  return true;
});

// ---------------------------------------------------------------------------
console.log('\n12. 範本 repo 的設定');

// 引導網頁第 3 步會把助理導到 Vercel 的 Deploy Button，那個按鈕要有
// 一個「真的存在而且公開」的 repo 才能用。repo 不存在時，助理會看到
// Vercel 一句看不懂的錯誤，而且完全不知道是維護者的問題。
//
// 這裡不能直接連網路（檢查要能離線跑），所以只做兩件事：
//   1. 確認 repoUrl 是個合法的 GitHub 網址
//   2. 如果還是預設值，提醒「上線前要換成你自己的 repo 並確認它存在」
check('wizard/config.js 的 repoUrl 格式正確', () => {
  const text = read('wizard/config.js');
  const match = text.match(/repoUrl:\s*'([^']+)'/);
  if (!match) throw new Error('找不到 repoUrl');
  const url = match[1];
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
    throw new Error(`repoUrl 不是合法的 GitHub repo 網址：${url}`);
  }
  return true;
});

// 引導網頁的一鍵部署會去讀 repoUrl 指向的 repo。如果那個 repo 不存在、
// 或是 private，別人按「Deploy to Vercel」就會失敗 —— 而失敗訊息是 Vercel
// 的英文錯誤，研究室看不懂，也不知道要回頭找誰。
//
// 所以這裡真的去問一次 git：這個 repo 匿名讀得到嗎？
//   * 讀得到 → 沒問題，不吵。
//   * 讀不到 → 印提醒（不是失敗：可能是這台機器沒網路，不該讓本機離線
//     就把整份交付擋下來）。
function probeRemoteRepo(url) {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
      stdio: 'pipe',
      timeout: 15000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return { reachable: true };
  } catch (error) {
    return { reachable: false, reason: (error.stderr ? String(error.stderr) : error.message).trim() };
  }
}

check('repoUrl 指向的 repo 匿名讀得到（一鍵部署才不會失敗）', () => {
  const text = read('wizard/config.js');
  const match = text.match(/repoUrl:\s*'([^']+)'/);
  if (!match) throw new Error('找不到 repoUrl');

  const probe = probeRemoteRepo(match[1]);
  if (!probe.reachable) {
    notes.push(`問不到 ${match[1]}（${probe.reason.split('\n')[0]}）。`
      + '如果只是這台機器沒網路就沒關係；否則請確認這個 repo 已建立、是 public，'
      + '不然引導網頁的「一鍵部署」會失敗。');
  }
  return true;
});

// 使用者可見的「第 N 步」必須跟引導網頁的編號一致。
//
// 為什麼要專門測這個：api/setup-status.js 與 api/setup.js 是照「規格書的
// 0～6 編號」寫的，但引導網頁畫面上顯示的是「第 1～7 步」，兩邊差一號。
// 於是錯誤訊息會叫使用者「回第 3 步建立資料庫」——但資料庫其實在第 4 步，
// 第 3 步是「複製程式碼並部署」。使用者照著點會跳到完全不相關的頁面，
// 而且他不會知道自己被指錯了，只會覺得「這份說明在騙人」。
//
// 這裡把「引導網頁第 N 步」這句話抓出來，比對 STEPS 的實際編號。
//
// 文件（docs/installation.md）也要掃：助理一手拿文件、一手點引導網頁，
// 文件寫錯同樣會把他帶到錯的步驟，而且他更難自己發現。
check('使用者可見的「引導網頁第 N 步」沒有差一號', () => {
  // 引導網頁的步驟編號（順序＝畫面上的 1、2、3…）
  const steps = [
    { id: 'start', label: '開始之前' },
    { id: 'github', label: '建立 GitHub 帳號' },
    { id: 'deploy', label: '複製程式碼並部署' },
    { id: 'database', label: '建立資料庫' },
    { id: 'schema', label: '建立資料表' },
    { id: 'admin', label: '建立管理員帳號' },
    { id: 'done', label: '完成了' }
  ];

  // 這些關鍵字出現在「第 N 步」附近時，用來判斷那句話指的是哪一個步驟。
  // 用語意而不是數字，才能抓出「數字寫錯」。
  const keywordToStep = [
    // 網址指涉：文件裡常用「點引導網頁第 N 步的連結（<https://…>）」，
    // 那個網址本身就決定了是哪一步，比文字更可靠。
    { step: 'github', pattern: /github\.com\/signup/i },
    { step: 'database', pattern: /supabase\.com\/dashboard/i },
    { step: 'database', pattern: /Supabase\s*資料庫|建立資料庫|連到資料庫|資料庫的連線|金鑰填好/ },
    { step: 'schema', pattern: /建表語法|資料表|SQL Editor|複製第一段|複製第二段/ },
    { step: 'deploy', pattern: /Deploy to Vercel|複製程式碼|部署|Vercel/ },
    { step: 'admin', pattern: /管理員帳號|第一次使用/ }
  ];

  const sources = ['index.html', 'api/setup-status.js', 'api/setup.js', 'docs/installation.md'];
  const problems = [];

  for (const file of sources) {
    const text = read(file);
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // 只找「引導網頁第 N 步」這種明確指向引導網頁的句子。
      // 一般程式註解或別的「第 N 步」不算。
      const mention = line.match(/引導網頁[^'"]{0,12}?第\s*(\d+)\s*步/);
      if (!mention) return;
      const claimed = Number(mention[1]);

      // 這句話在講哪個步驟？看同一行有沒有語意關鍵字。
      const matched = keywordToStep.find(entry => entry.pattern.test(line));
      if (!matched) return;

      const actualNumber = steps.findIndex(step => step.id === matched.step) + 1;
      if (actualNumber <= 0) return;
      if (claimed === actualNumber) return;

      problems.push(
        `${file}:${index + 1} 說「第 ${claimed} 步」是「${steps[actualNumber - 1].label}」，`
        + `但引導網頁上那是第 ${actualNumber} 步`
      );
    });
  }

  if (problems.length) throw new Error(problems.join('；'));
  return true;
});

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.error(`✘ 專案結構檢查失敗：${failures.length} 項`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✔ 專案結構檢查通過（${REQUIRED_FILES.length} 個必要檔案、${JS_TARGETS.length} 個 JS 檔）`);
if (notes.length) for (const note of notes) console.log(`  · ${note}`);
