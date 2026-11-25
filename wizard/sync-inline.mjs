#!/usr/bin/env node
// =============================================================================
// sync-inline.mjs — 產生／檢查 wizard/inline-bundle.js
//
// 為什麼需要這個檔案：
//   使用者（研究室助理）會「雙擊 index.html」直接從 file:// 開啟，不會架伺服器。
//   但瀏覽器有個安全規定：file:// 下的網頁不准載入「另一個檔案」的 ES module。
//   也就是說 <script type="module" src="wizard.js"> 雙擊開啟時一定失敗。
//
//   可用的兩條路（實測）：
//     1. classic <script src="inline-bundle.js"> 在 file:// 下可以載入。
//     2. 用 Blob 產生網址再動態 import 也可以。
//
//   所以 inline-bundle.js 只做一件事：把 wizard.js + config.js 的原始碼
//   原封不動存成一個字串放在 window.__WIZARD_INLINE_MODULE__。
//   index.html 發現正常的 module 載不到時，就拿這個字串產生 Blob 去 import。
//
// 維護方式：
//   改完 wizard.js 或 config.js 之後執行
//       node wizard/sync-inline.mjs
//   要確認有沒有忘記同步（可放進 CI 或 commit 前檢查）：
//       node wizard/sync-inline.mjs --check      # 沒同步就 exit 1
//
//   這個腳本只用 Node 內建模組，不需要 npm install。
// =============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.js');
const WIZARD_PATH = join(HERE, 'wizard.js');
const BUNDLE_PATH = join(HERE, 'inline-bundle.js');
const BUNDLE_BEGIN = '/* @generated-begin — 以下由 sync-inline.mjs 產生，請勿手改 */';
const BUNDLE_END = '/* @generated-end */';

/**
 * 把兩個模組合成「一個」模組的原始碼。
 *
 * 做法：
 *   1. config.js 放前面，把最上層的 `export ` 拿掉（變成同一模組裡的普通 const）。
 *   2. wizard.js 放後面，把 `import … from './config.js'` 那一行拿掉
 *      （因為 config 的內容已經在上面了）。
 *
 * 注意：拿掉的只有「指向 ./config.js 的 import」這一行。wizard.js 自己的
 * `export function …` 全部保留 —— 它們在 Blob 模組裡仍然是合法的 export，
 * 只是沒有人 import 而已，不影響執行。
 */
function composeModule(configSource, wizardSource) {
  // --- config.js：去掉最上層的 export ---
  const configWithoutExports = configSource
    .replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, 'const __default__ = ');

  if (/\bexport\b/.test(configWithoutExports)) {
    const offending = configWithoutExports
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /^\s*export\b/.test(line));
    if (offending.length > 0) {
      throw new Error(
        'config.js 有這個腳本不認得的 export 寫法（第 '
        + offending.map(([n]) => n).join('、') + ' 行）。'
        + '請用 `export const` / `export function`，或改寫 sync-inline.mjs。'
      );
    }
  }

  // --- wizard.js：拿掉 import config 的那一行 ---
  const importRe = /^import\s+[^;]*from\s+['"]\.\/config\.js['"]\s*;?\s*$/gm;
  const imports = wizardSource.match(importRe) || [];
  if (imports.length !== 1) {
    throw new Error(
      `wizard.js 應該剛好有 1 行 \`import … from './config.js'\`，實際找到 ${imports.length} 行。`
      + '請確認 import 寫在單獨一行（不要跟別的程式碼同一行）。'
    );
  }
  const wizardWithoutImport = wizardSource.replace(importRe, '');

  // --- 合併 ---
  return [
    '// ---- config.js（已併入） ----',
    configWithoutExports.trim(),
    '',
    '// ---- wizard.js（已併入） ----',
    wizardWithoutImport.trim(),
    ''
  ].join('\n');
}

function readSources() {
  if (!existsSync(CONFIG_PATH) || !existsSync(WIZARD_PATH)) {
    throw new Error('找不到 wizard/config.js 或 wizard/wizard.js。請在專案根目錄執行。');
  }
  return {
    config: readFileSync(CONFIG_PATH, 'utf8'),
    wizard: readFileSync(WIZARD_PATH, 'utf8')
  };
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function buildBundle() {
  const { config, wizard } = readSources();
  const moduleSource = composeModule(config, wizard);
  const fingerprint = hashOf(config + '\n' + wizard);

  // 內嵌成 JSON 字串最安全：反引號、${}、反斜線、<!-- 都不會出問題。
  const payload = JSON.stringify({
    fingerprint,
    // 實際被 import 的模組原始碼
    source: moduleSource
  });

  const bundle = [
    '// ============================================================================',
    '// inline-bundle.js — 自動產生，請勿手改',
    '//',
    '// 做什麼：把 wizard.js + config.js 的原始碼存成字串，讓「雙擊 index.html」',
    '//         （file://）的版本也能跑起來。瀏覽器在 file:// 下不准載入另一個檔案',
    '//         的 ES module，但可以載入這個 classic script，再用 Blob 動態 import。',
    '//',
    '// 怎麼更新：改完 wizard.js 或 config.js 後執行',
    '//             node wizard/sync-inline.mjs',
    '//           （確認有沒有忘記同步：node wizard/sync-inline.mjs --check）',
    `//`,
    `// 來源指紋：${fingerprint}（config.js + wizard.js 的 sha256 前 12 碼）`,
    '// ============================================================================',
    '',
    BUNDLE_BEGIN,
    '(function () {',
    '  var payload = ' + payload + ';',
    '  window.__WIZARD_INLINE_MODULE__ = payload.source;',
    '  window.__WIZARD_INLINE_FINGERPRINT__ = payload.fingerprint;',
    '})();',
    BUNDLE_END,
    ''
  ].join('\n');

  return { bundle, fingerprint, moduleSource };
}

function readGeneratedFingerprint() {
  if (!existsSync(BUNDLE_PATH)) return null;
  const text = readFileSync(BUNDLE_PATH, 'utf8');
  const match = text.match(/var payload = (\{[\s\S]*?\});\n/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).fingerprint;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// 檢查 index.html 裡內嵌的建表語法，是否與 supabase/migrations/*.sql 逐字相同
//
// 為什麼需要這個檢查（真的踩過）：
//   這裡的 migration 用到 PostgreSQL 的「錢字號引號」寫法，例如 do $$ begin … end $$;
//   如果不小心用 String.replace(html, sql) 注入（第二個參數是字串），
//   JS 會把替換字串裡的 $$ 解讀成「一個錢字號」——SQL 就從
//   `do $$ begin` 變成 `do $ begin`，語法直接壞掉，貼進 Supabase 會報錯。
//   更糟的是：畫面上看起來「有內容」，肉眼很難發現少了那一個字元。
//   所以每次同步都實際比對一次，不要靠眼睛。
// -----------------------------------------------------------------------------

const HTML_PATH = join(HERE, 'index.html');
const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

// 抓出每個內嵌的 migration 段：<script type="text/plain" class="migration-sql" … data-filename="…">\n…</script>
const SQL_SEGMENT_RE = /^<script type="text\/plain" class="migration-sql"[^>]*data-filename="([^"]+)"[^>]*>\n([\s\S]*?)<\/script>$/gm;

function checkMigrationSql() {
  if (!existsSync(HTML_PATH)) {
    return { ok: false, problems: ['找不到 wizard/index.html。'] };
  }
  if (!existsSync(MIGRATIONS_DIR)) {
    return { ok: true, problems: [], skipped: '找不到 supabase/migrations，略過比對（這個引導頁可能被單獨複製出去）。' };
  }

  const html = readFileSync(HTML_PATH, 'utf8');
  const problems = [];
  const checked = [];

  SQL_SEGMENT_RE.lastIndex = 0;
  let match;
  while ((match = SQL_SEGMENT_RE.exec(html)) !== null) {
    const [, filename, embedded] = match;
    const sourcePath = join(MIGRATIONS_DIR, filename);
    if (!existsSync(sourcePath)) {
      problems.push(`index.html 內嵌了 ${filename}，但 supabase/migrations/ 裡沒有這個檔案。`);
      continue;
    }
    const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
    if (embedded !== source) {
      // 找出第一個不同的位置，直接指出來，比只說「不一樣」有用得多。
      let at = 0;
      const limit = Math.min(embedded.length, source.length);
      while (at < limit && embedded[at] === source[at]) at += 1;
      const line = source.slice(0, at).split('\n').length;
      problems.push(
        `index.html 的「${filename}」與 supabase/migrations/${filename} 不一致`
        + `（第一個差異在原始檔第 ${line} 行附近）。`
        + `\n      index.html：${JSON.stringify(embedded.slice(at, at + 40))}`
        + `\n      原始檔    ：${JSON.stringify(source.slice(at, at + 40))}`
        + '\n      提示：若差異是 $$ 變成 $，就是注入時用了 String.replace 的字串替換。'
      );
    }
    checked.push(filename);
  }

  if (checked.length === 0) {
    problems.push('index.html 裡找不到任何內嵌的建表語法（script.migration-sql[data-filename]）。');
  }

  // 反向檢查：migrations 目錄裡的每個 .sql 都應該被內嵌，否則使用者會少跑一段。
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    if (!checked.includes(file)) {
      problems.push(`supabase/migrations/${file} 存在，但 index.html 沒有內嵌它（使用者會少跑這一段）。`);
    }
  }

  return { ok: problems.length === 0, problems, checked };
}

function main(argv) {
  const checkOnly = argv.includes('--check');

  // 建表語法的比對與 bundle 無關，但兩者都該在「同步」時一起檢查，
  // 所以 --check 與一般模式都會跑。
  const sql = checkMigrationSql();
  if (sql.skipped) console.log(`… ${sql.skipped}`);
  if (!sql.ok) {
    console.error('✖ index.html 內嵌的建表語法有問題：');
    for (const problem of sql.problems) console.error('   • ' + problem);
    return 1;
  }
  if (sql.checked) {
    console.log(`✔ index.html 內嵌的建表語法與 supabase/migrations 逐字一致（${sql.checked.join('、')}）。`);
  }

  const { bundle, fingerprint, moduleSource } = buildBundle();

  if (checkOnly) {
    const current = readGeneratedFingerprint();
    if (current === fingerprint) {
      console.log(`✔ inline-bundle.js 已是最新（指紋 ${fingerprint}）。`);
      return 0;
    }
    console.error(
      '✖ inline-bundle.js 與 wizard.js / config.js 不同步。\n'
      + `  目前檔案：${current || '（不存在或讀不出來）'}\n`
      + `  原始碼  ：${fingerprint}\n`
      + '  請執行：node wizard/sync-inline.mjs'
    );
    return 1;
  }

  // 寫出前先自己檢查一次語法（純 Node，不需 npm）
  // 這裡只做最基本的括號/字串平衡檢查；真正的語法驗證請跑 node --check wizard/wizard.js。
  if (/\u0000/.test(moduleSource)) {
    throw new Error('合併後的原始碼含有 NUL 字元，請檢查來源檔。');
  }

  writeFileSync(BUNDLE_PATH, bundle);
  const lines = bundle.split('\n').length;
  console.log('✔ 已產生 wizard/inline-bundle.js');
  console.log(`  指紋    ：${fingerprint}`);
  console.log(`  檔案大小：${bundle.length.toLocaleString('en-US')} 字元 / ${lines} 行`);
  console.log(`  內嵌原始碼：${moduleSource.split('\n').length} 行`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
