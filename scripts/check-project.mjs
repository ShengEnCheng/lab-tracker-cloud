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
  // 工具
  'scripts/dev-server.mjs',
  // 引導網頁
  'wizard/index.html',
  // 文件
  'docs/installation.md',
  'docs/handover.md',
  // 測試
  'tests/unit.test.mjs',
  'tests/integration.test.mjs',
  'tests/ui.test.mjs',
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

// ---------------------------------------------------------------------------
console.log('\n11. .gitignore 擋住機密檔');
check('.gitignore 忽略 .env.local', () => {
  const text = read('.gitignore');
  if (!text.includes('.env')) throw new Error('沒有忽略 .env');
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
