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
// 這支測試用真的 git 在暫存目錄裡重建「研究室用一鍵部署拿到的副本」，
// 把實際會發生的事一件一件記下來：
//
//   1. 副本只有一個 commit、沒有 upstream（所以不會有 Sync fork）
//   2. 版本有落差時，用 merge 會產生物件衝突（add/add）—— 非技術人員無法處理
//   3. reset --hard 是乾淨可靠的更新方式，代價是本機改過的程式碼會消失
//   4. 因此「研究室不該自己改程式碼」——他們該調的東西都在環境變數與資料庫
//   5. 維護者查得到每個研究室實際在跑哪一版（/api/health 的 version）
//
// 這樣文件就只能寫「真的做得到」的步驟。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

/**
 * 建立一個「研究室用一鍵部署拿到的副本」。
 *
 * 真實的一鍵部署做的事：把範本的檔案複製過去，在研究室的帳號建一個全新的 repo，
 * 裡面只有一個 commit。沒有 upstream、沒有共同的祖先。
 *
 * 這裡從本機的專案目錄複製檔案（不是去 clone 遠端），這樣測試不用網路。
 */
function makeLabRepo(root, { customize = false } = {}) {
  const labDir = join(root, 'lab');
  cpSync(REPO_ROOT, labDir, {
    recursive: true,
    filter: source => {
      const relative = source.slice(REPO_ROOT.length);
      // .git、node_modules、暫存產物都不會進 repo。
      return !/^\/?(\.git|node_modules|\.vercel|\.update-temp)(\/|$)/.test(relative)
        && !/\.log$/.test(source)
        && !/\.DS_Store$/.test(source);
    }
  });

  git(labDir, ['init', '-q', '-b', 'main']);
  git(labDir, ['add', '-A']);
  git(labDir, ['commit', '-q', '-m', 'Initial commit from Vercel template']);
  git(labDir, ['remote', 'add', 'origin', 'https://github.com/someLab/lab-tracker.git']);

  if (customize) {
    // 研究室自己改了一點東西（例如把副標題換成自己的說法）。
    // 真實世界裡「研究室的版本比範本舊」也是這種形狀：檔案內容跟範本不同。
    const indexPath = join(labDir, 'index.html');
    const html = readFileSync(indexPath, 'utf8');
    writeFileSync(
      indexPath,
      html.replace('OPT_Bone・music40・自訂期程', '我們的收案流程'),
      'utf8'
    );
    git(labDir, ['commit', '-qam', '改成我們研究室的說法']);
  }

  return labDir;
}

/**
 * 確保 repo 有 upstream 指向本機的專案目錄，並回傳 fetch 到的 commit。
 *
 * 用本機路徑而不是 GitHub 網址，這樣測試不需要網路；git 判斷
 * 「有沒有共同祖先」的邏輯跟遠端完全一樣。
 */
function ensureUpstream(cwd) {
  const remotes = git(cwd, ['remote']).split('\n');
  if (remotes.includes('upstream')) git(cwd, ['remote', 'remove', 'upstream']);
  git(cwd, ['remote', 'add', 'upstream', REPO_ROOT]);
  git(cwd, ['fetch', '-q', 'upstream']);
  return git(cwd, ['rev-parse', '--verify', 'upstream/main']);
}

console.log('\n更新路徑驗證（研究室部署好之後怎麼更新）\n');

if (!gitAvailable()) {
  console.log('  ⚠ 這台機器沒有 git，跳過這支測試（不影響其他測試）。');
  console.log('\n結果：0 項（已跳過）\n');
  process.exit(0);
}

const workRoot = mkdtempSync(join(tmpdir(), 'lab-update-'));

try {
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
    const remotes = git(cleanLab, ['remote']);
    assertEqual(remotes, 'origin', '一鍵部署的副本只會有 origin，不會有 upstream');
  });

  // ===========================================================================
  // 2. 版本有落差時，merge 會產生衝突 —— 這條路對非技術人員不可行
  // ===========================================================================
  console.log('\n2. 版本有落差時，merge 會產生衝突（所以不能叫研究室自己 merge）');

  check('檔案內容跟範本不同時，merge 會產生 add/add 衝突', () => {
    // 這是關鍵發現：因為兩邊沒有共同祖先，git 無法判斷「誰改了哪一行」，
    // 只能整個檔案對整個檔案比 —— 只要檔案內容不同就衝突。
    const staleLab = makeLabRepo(join(workRoot, 'stale'), { customize: true });
    const upstreamRef = ensureUpstream(staleLab);

    let conflictFailed = false;
    let errorText = '';
    try {
      git(staleLab, ['merge', upstreamRef, '--allow-unrelated-histories', '-m', '更新']);
    } catch (error) {
      conflictFailed = true;
      errorText = error.message;
    }

    assert(conflictFailed, '內容不同的 merge 應該要衝突，但它自己合完了');
    assert(
      /CONFLICT|conflict/i.test(errorText),
      `失敗原因應該是衝突，實際是：${errorText}`
    );
    assert(
      /add\/add/i.test(errorText),
      `衝突型態應該是 add/add（因為沒有共同祖先），實際是：${errorText}`
    );

    // 收尾：把半完成的 merge 狀態清掉，避免影響之後的測試。
    if (existsSync(join(staleLab, '.git', 'MERGE_HEAD'))) {
      git(staleLab, ['merge', '--abort']);
    }
  });

  check('沒有共同祖先時，連 --allow-unrelated-histories 也不夠', () => {
    // 這正是文件原本寫錯的地方：以為加了 --allow-unrelated-histories 就沒事。
    // 它只是「允許合併」，不代表「合得起來」。
    const staleLab = makeLabRepo(join(workRoot, 'stale2'), { customize: true });
    const upstreamRef = ensureUpstream(staleLab);
    let conflicted = false;
    try {
      git(staleLab, ['merge', upstreamRef, '--allow-unrelated-histories', '-m', '更新']);
    } catch {
      conflicted = true;
    }
    assert(conflicted, '應該要衝突；如果這裡不衝突了，代表 git 行為改變，文件要重寫');
  });

  // ===========================================================================
  // 3. reset --hard 是乾淨可靠的更新方式
  // ===========================================================================
  console.log('\n3. reset --hard 是乾淨可靠的更新方式');

  check('reset --hard 之後，程式碼跟範本完全一致', () => {
    const lab = makeLabRepo(join(workRoot, 'reset'));
    const upstreamRef = ensureUpstream(lab);
    git(lab, ['reset', '--hard', upstreamRef]);

    // 工作目錄要乾淨。
    const status = git(lab, ['status', '--porcelain']);
    assertEqual(status, '', `reset 之後工作目錄應該乾淨，實際是：${status}`);

    // 而且真的跟範本一樣（不只看 commit 指標）。
    assertEqual(
      git(lab, ['rev-parse', 'HEAD']),
      upstreamRef,
      'reset 之後 HEAD 應該就是範本的最新 commit'
    );
  });

  check('reset --hard 會把本機改過的程式碼蓋掉（所以研究室不該改程式碼）', () => {
    const lab = makeLabRepo(join(workRoot, 'reset-custom'), { customize: true });
    const before = readFileSync(join(lab, 'index.html'), 'utf8');
    assert(before.includes('我們的收案流程'), '測試資料準備失敗：客製化文字不在檔案裡');

    const upstreamRef = ensureUpstream(lab);
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
    const tracked = git(REPO_ROOT, ['ls-files']).split('\n');
    const forbidden = tracked.filter(file => (
      /^\.env$/.test(file) || /^\.env\.local$/.test(file) || /\.env\..*\.local$/.test(file)
    ));
    assertEqual(forbidden.join(','), '', `版控裡不應該有真的 .env 檔，發現：${forbidden.join(', ')}`);

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
    assertEqual(
      hardcoded.join(','),
      '',
      `前端不應該寫死 Supabase 網址，發現：${hardcoded.join(', ')}`
    );
  });

  // ===========================================================================
  // 4. 維護者查得到每個研究室實際在跑哪一版
  // ===========================================================================
  console.log('\n4. 維護者查得到每個研究室實際在跑哪一版');

  check('/api/health 會回版號（不用登入、不碰資料庫）', async () => {
    // 這是維護者唯一需要做的事：打開對方的 /api/health 看 version。
    // 所以這支端點必須「不依賴資料庫」（資料庫可能睡著或被暫停）。
    const source = readFileSync(join(REPO_ROOT, 'api/health.js'), 'utf8');
    assert(
      /version:\s*APP_VERSION/.test(source),
      '/api/health 應該回 version: APP_VERSION'
    );
    assert(
      /from '\.\.\/src\/lib\/app-info\.js'/.test(source),
      '/api/health 的版號應該來自 app-info.js（單一來源）'
    );
    // 不可以自己去讀資料庫來組回應 —— 那會在資料庫睡著時讓健檢也掛掉。
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

  check('查版號的指令寫在文件裡（維護者要知道怎麼查）', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/handover.md'), 'utf8');
    assert(
      /\/api\/health/.test(doc),
      '文件應該寫出怎麼查某個研究室在跑哪一版（打開 /api/health 看 version）'
    );
  });

  // ===========================================================================
  // 5. 文件寫的步驟必須真的做得到
  // ===========================================================================
  console.log('\n5. 文件寫的更新步驟必須真的做得到');

  const handover = readFileSync(join(REPO_ROOT, 'docs/handover.md'), 'utf8');

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
