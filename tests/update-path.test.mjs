// 「研究室部署好之後，維護者要怎麼幫他們更新」——把這條路真的走一遍。
//
// 為什麼需要這支測試：文件原本寫「叫研究室按 GitHub 的 Sync fork」，但那是錯的。
//
//   用引導網頁的一鍵部署建站時，Vercel 是把程式碼**複製一份**到研究室的 GitHub
//   （clone），不是 fork。兩者差別很大：
//
//     fork  → 有 upstream 血緣關係，GitHub 會出現「Sync fork」按鈕
//     clone → 完全獨立的 repo，跟範本沒有任何共同的祖先
//
//   所以「按 Sync fork」這個步驟根本做不出來 —— 那個按鈕不會出現。
//
// 這支測試用真的 git 在暫存目錄裡重建兩個 repo：
//
//   範本 repo   = 這個專案的檔案（維護者那邊）
//   研究室 repo = 用一鍵部署拿到的副本（只有一個 commit、沒有 upstream）
//
// 然後把實際會發生的事一件一件記下來：
//
//   1. 副本只有一個 commit、沒有 upstream（所以不會有 Sync fork）
//   2. 版本有落差時，用 merge 會產生 add/add 衝突 —— 非技術人員無法處理
//   3. reset --hard 是乾淨可靠的更新方式，代價是本機改過的程式碼會消失
//   4. 因此「研究室不該自己改程式碼」——他們該調的東西都在環境變數與資料庫
//   5. 維護者查得到每個研究室實際在跑哪一版（/api/health 的 version）
//
// 注意：這支測試**不依賴這個目錄是 git repo**（`git archive` 出來的副本沒有
// .git 也要能跑），所以範本 repo 是自己建的，不是拿 REPO_ROOT 當 upstream。

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.vercel', '.update-temp']);
const SKIP_FILES = /\.log$|\.DS_Store$/;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${label}`);
  } catch (error) {
    failed += 1;
    failures.push({ label, message: error.message });
    console.log(`  ✘ ${label}`);
    console.log(`      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}）`);
  }
}

// 在指定目錄跑 git。失敗時把 stdout/stderr 一起丟出來，否則很難知道為什麼。
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Lab User',
        GIT_AUTHOR_EMAIL: 'lab@example.edu',
        GIT_COMMITTER_NAME: 'Lab User',
        GIT_COMMITTER_EMAIL: 'lab@example.edu',
        GIT_TERMINAL_PROMPT: '0'
      }
    }).trim();
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : '';
    const stdout = error.stdout ? String(error.stdout) : '';
    const detail = [stdout, stderr].filter(Boolean).join('\n').trim();
    const wrapped = new Error(`git ${args.join(' ')} 失敗：${detail || error.message}`);
    wrapped.status = error.status;
    throw wrapped;
  }
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 把這個專案的檔案複製到 dir（不含 .git 與暫存產物）。
function copyProjectFiles(dir) {
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: source => {
      const relative = source.slice(REPO_ROOT.length).replace(/^\//, '');
      if (!relative) return true;
      const top = relative.split('/')[0];
      if (SKIP_DIRECTORIES.has(top)) return false;
      return !SKIP_FILES.test(source);
    }
  });
}

// 建一個「有版控的 repo」：檔案 + git init + 一個 commit。
function makeRepo(dir, message) {
  copyProjectFiles(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return dir;
}

/**
 * 範本 repo：維護者那邊的程式碼。多一個 commit 代表「發布了新版」。
 *
 * 真實世界裡版本落差可能來自任何檔案；這裡改 README 與 index.html，
 * 是因為那兩個檔案在真實更新時幾乎一定會變（也是原本 merge 衝突的常客）。
 */
function makeTemplateRepo(dir) {
  makeRepo(dir, 'v1.0.0');
  writeFileSync(join(dir, 'README.md'), `${readFileSync(join(dir, 'README.md'), 'utf8')}\n<!-- 1.1.0 -->\n`);
  const indexPath = join(dir, 'index.html');
  writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}\n<!-- 1.1.0 -->\n`);
  git(dir, ['commit', '-qam', 'v1.1.0']);
  return dir;
}

/**
 * 研究室 repo：用一鍵部署拿到的副本。
 *
 * 真實的一鍵部署做的事：把範本「當時的」檔案複製過去，在研究室的帳號建一個
 * 全新的 repo，裡面只有一個 commit。沒有 upstream、沒有共同的祖先。
 * 所以這裡先建在範本發布新版「之前」的狀態。
 */
function makeLabRepo(dir, { customize = false } = {}) {
  makeRepo(dir, 'Initial commit from Vercel template');
  git(dir, ['remote', 'add', 'origin', 'https://github.com/someLab/lab-tracker.git']);

  if (customize) {
    // 研究室自己改了一點東西（例如把副標題換成自己的說法）。
    // 用頁首副標題的整個元素當錨點：副標題文字怎麼換都不用動這裡；
    // 只有 <div class="brand-sub"> 的標籤結構或 class 名稱改了才要跟著改。
    const indexPath = join(dir, 'index.html');
    const html = readFileSync(indexPath, 'utf8');
    const subtitle = /<div class="brand-sub">[^<]*<\/div>/;
    if (!subtitle.test(html)) {
      throw new Error('測試要模擬研究室改副標題，但 index.html 裡找不到 <div class="brand-sub">；請更新 makeLabRepo 的錨點');
    }
    writeFileSync(indexPath, html.replace(subtitle, '<div class="brand-sub">我們的收案流程</div>'));
    git(dir, ['commit', '-qam', '改成我們研究室的說法']);
  }

  return dir;
}

// 讓研究室 repo「知道」範本在哪 —— 就是文件裡那行 git remote add upstream。
function addUpstream(labDir, templateDir) {
  const remotes = git(labDir, ['remote']).split('\n');
  if (remotes.includes('upstream')) git(labDir, ['remote', 'remove', 'upstream']);
  git(labDir, ['remote', 'add', 'upstream', templateDir]);
  git(labDir, ['fetch', '-q', 'upstream']);
  return git(labDir, ['rev-parse', '--verify', 'upstream/main']);
}

// 遞迴列出專案檔案（不需要 .git）。
function listProjectFiles(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || SKIP_DIRECTORIES.has(entry.name)) continue;
    if (SKIP_FILES.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listProjectFiles(full, base, found);
    else found.push(full.slice(base.length).replace(/^\//, ''));
  }
  return found;
}

console.log('\n更新路徑驗證（研究室部署好之後怎麼更新）\n');

if (!gitAvailable()) {
  console.log('  ⚠ 這台機器沒有 git，跳過這支測試（不影響其他測試）。');
  console.log('\n結果：0 項（已跳過）\n');
  process.exit(0);
}

const workRoot = mkdtempSync(join(tmpdir(), 'lab-update-'));

try {
  const templateDir = makeTemplateRepo(join(workRoot, 'template'));

  // ===========================================================================
  // 1. 一鍵部署拿到的副本，跟範本沒有血緣關係
  // ===========================================================================
  console.log('1. 一鍵部署拿到的副本，跟範本沒有血緣關係');

  const cleanLab = makeLabRepo(join(workRoot, 'clean'));

  check('副本只有一個 commit（不是完整歷史）', () => {
    const count = Number(git(cleanLab, ['rev-list', '--count', 'HEAD']));
    assertEqual(count, 1, '一鍵部署的副本應該只有 1 個 commit');
  });

  check('副本沒有 upstream（所以不會有 Sync fork 按鈕）', () => {
    assertEqual(git(cleanLab, ['remote']), 'origin', '一鍵部署的副本只會有 origin');
  });

  check('副本跟範本確實沒有共同的祖先（合併時會遇到 unrelated histories）', () => {
    // git 認定的「共同祖先」是 commit 血緣，不是檔案內容。兩邊各是一個孤兒
    // commit，所以 git 會說 histories 不相關 —— 這正是 add/add 衝突的根。
    const labHead = git(cleanLab, ['rev-parse', 'HEAD']);
    const templateHead = git(templateDir, ['rev-parse', 'HEAD']);
    assert(labHead !== templateHead, '兩邊應該是不同的 commit');

    let unreachable = false;
    try {
      git(cleanLab, ['merge-base', labHead, templateHead]);
    } catch {
      unreachable = true;
    }
    assert(unreachable, '兩邊應該找不到共同祖先；找得到就代表這個前提變了，文件要重寫');
  });

  // ===========================================================================
  // 2. 版本有落差時，merge 會產生衝突 —— 這條路對非技術人員不可行
  // ===========================================================================
  console.log('\n2. 版本有落差時，merge 會產生衝突（所以不能叫研究室自己 merge）');

  check('直接 merge 會被 unrelated histories 拒絕', () => {
    const lab = makeLabRepo(join(workRoot, 'plain'), { customize: true });
    const upstreamRef = addUpstream(lab, templateDir);
    let rejected = false;
    let text = '';
    try {
      git(lab, ['merge', upstreamRef, '-m', '更新']);
    } catch (error) {
      rejected = true;
      text = error.message;
    }
    assert(rejected, '沒有共同祖先時，plain merge 應該被拒絕，但它合完了');
    assert(
      /unrelated histories/i.test(text),
      `應該提到 unrelated histories，實際是：${text}`
    );
  });

  check('加了 --allow-unrelated-histories 仍然每個檔案都 add/add 衝突', () => {
    // 這是關鍵發現：加了那個參數只是「允許合併」，不代表「合得起來」。
    // 因為沒有共同祖先，git 無法逐行比對，只能整檔比 → 內容不同就衝突。
    const lab = makeLabRepo(join(workRoot, 'conflict'), { customize: true });
    const upstreamRef = addUpstream(lab, templateDir);

    let conflicted = false;
    let text = '';
    try {
      git(lab, ['merge', upstreamRef, '--allow-unrelated-histories', '-m', '更新']);
    } catch (error) {
      conflicted = true;
      text = error.message;
    }

    assert(conflicted, '內容不同的 merge 應該要衝突，但它自己合完了');
    assert(/CONFLICT|conflict/i.test(text), `失敗原因應該是衝突，實際是：${text}`);
    assert(/add\/add/i.test(text), `衝突型態應該是 add/add，實際是：${text}`);

    if (existsSync(join(lab, '.git', 'MERGE_HEAD'))) git(lab, ['merge', '--abort']);
  });

  // ===========================================================================
  // 3. reset --hard 是乾淨可靠的更新方式
  // ===========================================================================
  console.log('\n3. reset --hard 是乾淨可靠的更新方式');

  check('reset --hard 之後，程式碼真的變成最新版', () => {
    const lab = makeLabRepo(join(workRoot, 'reset'));
    const upstreamRef = addUpstream(lab, templateDir);

    // 更新前：是新版才有的內容，所以不該出現。
    const before = readFileSync(join(lab, 'README.md'), 'utf8');
    assert(!before.includes('<!-- 1.1.0 -->'), '測試資料準備失敗：更新前就有新版內容');

    git(lab, ['reset', '--hard', upstreamRef]);

    assertEqual(git(lab, ['status', '--porcelain']), '', 'reset 之後工作目錄應該乾淨');
    assertEqual(git(lab, ['rev-parse', 'HEAD']), upstreamRef, 'HEAD 應該指向範本最新 commit');

    // 光看 commit 不夠，要確認檔案內容真的換了。
    const after = readFileSync(join(lab, 'README.md'), 'utf8');
    assert(after.includes('<!-- 1.1.0 -->'), 'reset 之後應該是新版的檔案內容');
  });

  check('reset --hard 會把本機改過的程式碼蓋掉（所以研究室不該改程式碼）', () => {
    const lab = makeLabRepo(join(workRoot, 'reset-custom'), { customize: true });
    const before = readFileSync(join(lab, 'index.html'), 'utf8');
    assert(before.includes('我們的收案流程'), '測試資料準備失敗：客製化文字不在檔案裡');

    const upstreamRef = addUpstream(lab, templateDir);
    git(lab, ['reset', '--hard', upstreamRef]);

    const after = readFileSync(join(lab, 'index.html'), 'utf8');
    assert(
      !after.includes('我們的收案流程'),
      'reset --hard 應該會蓋掉本機的程式碼修改；如果沒有，代表這個方法不安全'
    );
  });

  check('研究室真正該調的設定都不在 repo 裡（所以更新不會弄壞他們的設定）', () => {
    // 這是整件事的關鍵：研究室特定的東西全在 Vercel 環境變數與 Supabase，
    // 不在版控裡。所以「更新程式碼」不會讓任何研究室連到錯的資料庫。
    const files = listProjectFiles(REPO_ROOT);
    const envFiles = files.filter(file => /(^|\/)\.env$|(^|\/)\.env\.local$|(^|\/)\.env\..*\.local$/.test(file));
    assertEqual(envFiles.join(','), '', `repo 裡不應該有真的 .env 檔，發現：${envFiles.join(', ')}`);

    // .gitignore 要擋住本機設定檔，否則有人一 commit 就把金鑰推上去了。
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    for (const pattern of ['.env', '.env.local', '.vercel']) {
      assert(
        ignore.split('\n').map(line => line.trim()).includes(pattern),
        `.gitignore 應該要擋住 ${pattern}`
      );
    }
  });

  check('程式碼裡沒有寫死任何研究室的 Supabase 網址', () => {
    // 如果寫死了，所有研究室就會連到同一個資料庫 —— 那是作者的，不是他們的。
    const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
    const hardcoded = html.match(/https:\/\/[a-z]{20}\.supabase\.co/gi) || [];
    assertEqual(hardcoded.join(','), '', `前端不應該寫死 Supabase 網址，發現：${hardcoded.join(', ')}`);
  });

  // ===========================================================================
  // 4. 維護者查得到每個研究室實際在跑哪一版
  // ===========================================================================
  console.log('\n4. 維護者查得到每個研究室實際在跑哪一版');

  check('/api/health 會回版號（不用登入、不碰資料庫）', () => {
    // 這是維護者唯一需要做的事：打開對方的 /api/health 看 version。
    // 所以這支端點必須「不依賴資料庫」（資料庫可能睡著或被暫停）。
    const source = readFileSync(join(REPO_ROOT, 'api/health.js'), 'utf8');
    assert(/version:\s*APP_VERSION/.test(source), '/api/health 應該回 version: APP_VERSION');
    assert(
      /from '\.\.\/src\/lib\/app-info\.js'/.test(source),
      '/api/health 的版號應該來自 app-info.js（單一來源）'
    );
    assert(
      !/rest\/v1/.test(source),
      '/api/health 不應該依賴資料庫（維護者要能在資料庫睡著時仍查得到版號）'
    );
  });

  check('版號只有一個來源，其他地方不能寫死', () => {
    const appInfo = readFileSync(join(REPO_ROOT, 'src/lib/app-info.js'), 'utf8');
    const match = appInfo.match(/APP_VERSION\s*=\s*'([^']+)'/);
    assert(match, 'app-info.js 應該定義 APP_VERSION');

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assertEqual(pkg.version, match[1], 'package.json 與 app-info.js 的版號要一致');
  });

  // ===========================================================================
  // 5. 文件寫的步驟必須真的做得到
  // ===========================================================================
  console.log('\n5. 文件寫的更新步驟必須真的做得到');

  const handover = readFileSync(join(REPO_ROOT, 'docs/handover.md'), 'utf8');

  check('查版號的指令寫在文件裡（維護者要知道怎麼查）', () => {
    assert(
      /\/api\/health/.test(handover),
      '文件應該寫出怎麼查某個研究室在跑哪一版（打開 /api/health 看 version）'
    );
  });

  check('handover.md 沒有把「Sync fork」當成更新步驟教人按', () => {
    // 可以「提到」Sync fork —— 文件需要解釋「為什麼沒有這個按鈕」，
    // 對照表也需要寫出 fork 那邊的做法。但不能把它當成更新指示：
    // 研究室照著做會發現那個按鈕根本不存在。
    //
    // 所以：跳過對照表（表格是在比較，不是在下指示），
    // 也跳過帶否定語氣的說明句，剩下的就是「教人怎麼做」的句子。
    const instructions = handover
      .split('\n')
      .filter(line => /Sync fork/i.test(line))
      .filter(line => !line.trim().startsWith('|'))
      .filter(line => !/不要|不該|不會|沒有|不能|別|不是|為什麼|做不出|做不到|原本|錯誤|錯的/.test(line));
    assertEqual(
      instructions.join(' / '),
      '',
      `文件把 Sync fork 當成做法在教：${instructions.join(' / ')}`
    );
  });

  check('handover.md 寫出 reset --hard 這條真正可行的路', () => {
    // 光是在內文提到 reset --hard 不夠 —— 要真的是一行可以複製貼上的指令。
    // （曾經的錯誤版本就是只在內文講得很好聽，讀者照做卻做不出來。）
    assert(
      /git reset --hard upstream\/main/.test(handover),
      '文件應該寫出可以直接複製的 `git reset --hard upstream/main` 指令'
    );
    assert(
      /git remote add upstream https:\/\/github\.com\//.test(handover),
      '文件應該寫出 `git remote add upstream <範本 repo>`（一鍵部署的副本沒有 upstream）'
    );
    assert(
      /git push --force origin main/.test(handover),
      '文件應該寫出 `git push --force origin main`（推回自己的 repo 才會重新部署）'
    );
  });

  check('文件說清楚「更新不會碰資料」', () => {
    assert(
      /資料不會受影響|不會碰資料|資料在 Supabase/.test(handover),
      '文件應該說明更新程式碼不會影響資料（資料在 Supabase，不在 repo 裡）'
    );
  });

  check('文件說清楚 migration 不會自動跑', () => {
    assert(
      /migration.*不會自動跑|不會自動套用/.test(handover),
      '文件應該提醒：新增 migration 不會自動套用到各研究室的資料庫'
    );
  });

  check('文件說清楚研究室不要自己改程式碼', () => {
    // 這是 reset --hard 的前提：如果研究室改了程式碼，更新時一定會被蓋掉。
    // 與其事後才發現，不如在文件裡講明白「要調東西請走環境變數／資料庫／回報維護者」。
    assert(
      /不要自己改|不該自己改|不要直接改程式碼|改程式碼.*會被蓋掉/.test(handover),
      '文件應該說明研究室不要自己改程式碼（更新時會被覆蓋）'
    );
  });
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

console.log(`\n結果：${passed} 項通過，${failed} 項失敗\n`);
if (failed > 0) {
  for (const failure of failures) {
    console.log(`  ✘ ${failure.label}`);
    console.log(`      ${failure.message}`);
  }
  process.exit(1);
}
