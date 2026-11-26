// 「研究室要不要自己動手更新？」——理想答案是不用。
//
// 使用者的想法：在開發的系統上加一個「更新」按鈕，按下去就把新版同步到
// 各研究室的 GitHub，Vercel 自動重新部署。
//
// 這個想法對了一半，卡在一個權限問題上：一鍵部署建出來的是研究室「自己的」
// repo，維護者對它沒有任何寫入權。所以反過來做 —— 讓研究室的 repo 自己去
// 公開的範本「拉」更新，由 GitHub Actions 每天跑一次。研究室完全不用動手。
//
// 這支測試用真的 git 把整條路走一遍（不 mock）：
//
//   範本 repo  →  研究室 repo（複製檔案、孤兒 commit）
//                    │
//                    └─ 跑 scripts/apply-template-update.sh
//                         → 檔案變成新版
//                         → .github/ 原樣保留（否則排程會把自己刪掉）
//                         → push 到 origin
//
// 以及那些「不做就會默默壞掉、而且不會報錯」的細節 —— 這是這支測試真正
// 有價值的地方，因為它們在畫面上完全看不出來：
//
//   · commit 作者必須是「研究室的人」。Vercel 的原生 Git 整合會檢查 commit
//     作者是不是團隊成員，不是就整筆擋掉部署，而且不會有任何錯誤訊息。
//     用 bot 信箱 → 網站永遠停在舊版，維運者完全查不出原因。
//   · 每 45 天要留一個心跳 commit。GitHub 會在公開 repo「60 天沒有活動」後
//     自動停用排程 workflow，同樣不通知。研究室平常不 commit，所以不補心跳
//     的話，自動更新會在兩個月後悄悄停止。
//   · 已經是同一版時不能重跑（排程每天跑，不能每天一個空 commit）。
//   · 版本倒退時不能降級（研究室比範本新時要被保護）。
//   · 範本 repo 自己跑時要立刻結束（不然會 reset 掉維護者正在改的東西）。
//   · 推送的差異裡不能出現 .github/workflows/（GITHUB_TOKEN 改不了那些檔案）。

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync
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
    throw new Error(`git ${args.join(' ')} 失敗：${detail || error.message}`);
  }
}

// 跑 update 腳本，回傳 { code, stdout, stderr }。
// 不從工作目錄呼叫 —— 腳本會用「自己所在的位置」決定要更新哪個 repo，
// 這正是它該有的行為（避免從別的資料夾誤改到錯的 repo）。
function runUpdate(labDir, args = [], env = {}) {
  try {
    const stdout = execFileSync('bash', [join(labDir, 'scripts/apply-template-update.sh'), ...args], {
      cwd: labDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // 刻意不設 GIT_AUTHOR_*：腳本應該自己從 repo 找出正確的作者。
        ...env
      }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : ''
    };
  }
}

function copyProjectFiles(dir) {
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: source => {
      const relative = source.slice(REPO_ROOT.length).replace(/^\//, '');
      if (!relative) return true;
      if (SKIP_DIRECTORIES.has(relative.split('/')[0])) return false;
      return !SKIP_FILES.test(source);
    }
  });
}

function setVersion(dir, version) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // 版號有三處要一致（app-info.js 是執行期讀的那份）。
  const appInfoPath = join(dir, 'src/lib/app-info.js');
  const appInfo = readFileSync(appInfoPath, 'utf8');
  writeFileSync(appInfoPath, appInfo.replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${version}'`));
}

function readVersion(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
}

/** 維護者那邊的範本 repo。 */
function makeTemplateRepo(dir, { version = '1.0.0' } = {}) {
  copyProjectFiles(dir);
  setVersion(dir, version);
  writeFileSync(join(dir, 'VERSION-NOTE.md'), `template ${version}\n`);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `v${version}`]);
  return dir;
}

/**
 * 研究室一鍵部署拿到的 repo。
 *
 * 關鍵：第一個 commit 的作者是「按一鍵部署的那個人」（實驗室管理員），
 * 不是 bot —— Vercel 就是靠這個判斷能不能部署。
 */
function makeLabRepo(dir, { origin, version = '1.0.0', labEmail = 'pi@lab.example.edu' }) {
  copyProjectFiles(dir);
  setVersion(dir, version);
  writeFileSync(join(dir, 'VERSION-NOTE.md'), `template ${version}\n`);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', 'Initial commit from Vercel template'], {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Lab PI',
      GIT_AUTHOR_EMAIL: labEmail,
      GIT_COMMITTER_NAME: 'Lab PI',
      GIT_COMMITTER_EMAIL: labEmail,
      GIT_TERMINAL_PROMPT: '0'
    }
  });
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

function makeBareOrigin(dir) {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir], { stdio: 'pipe' });
  return dir;
}

/** 讓最後一個 commit 看起來是很多天以前（測試心跳用）。 */
function ageLastCommit(dir, days) {
  const seconds = days * 86400;
  const stamp = `${Math.floor(Date.now() / 1000) - seconds} +0000`;
  const head = git(dir, ['rev-parse', 'HEAD']);
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', stamp], {
    cwd: dir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: stamp,
      GIT_AUTHOR_NAME: 'Lab PI',
      GIT_AUTHOR_EMAIL: 'pi@lab.example.edu',
      GIT_COMMITTER_NAME: 'Lab PI',
      GIT_COMMITTER_EMAIL: 'pi@lab.example.edu'
    }
  });
  if (git(dir, ['rev-parse', 'HEAD']) === head) {
    throw new Error('ageLastCommit 沒有改到 commit 時間');
  }
}

console.log('\n自動更新驗證（研究室要不要自己動手？）\n');

try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  console.log('  ⚠ 這台機器沒有 git，跳過這支測試。\n結果：0 項（已跳過）\n');
  process.exit(0);
}

if (!existsSync(join(REPO_ROOT, 'scripts/apply-template-update.sh'))) {
  console.log('  ✘ 找不到 scripts/apply-template-update.sh\n結果：0 項通過，1 項失敗\n');
  process.exit(1);
}

const workRoot = mkdtempSync(join(tmpdir(), 'lab-sync-'));

try {
  // =========================================================================
  // 1. 同步機制的形狀
  // =========================================================================
  console.log('1. 同步機制的形狀');

  check('update 腳本存在且可執行', () => {
    const scriptPath = join(REPO_ROOT, 'scripts/apply-template-update.sh');
    assert(existsSync(scriptPath), 'scripts/apply-template-update.sh 應該存在');
    const mode = statSync(scriptPath).mode;
    assert((mode & 0o111) !== 0, '腳本應該有執行權限（chmod +x）');
  });

  check('workflow 檔沒有把同步邏輯寫在裡面（改邏輯不必動 workflow）', () => {
    // GitHub 的 GITHUB_TOKEN 不能修改 .github/workflows/ 底下的檔案。
    // 所以同步邏輯必須在腳本裡，workflow 只負責「給 token、每天叫一次」。
    // 如果哪天有人把邏輯搬進 YAML，之後每次改邏輯都會推不上去。
    const workflowPath = join(REPO_ROOT, '.github/workflows/template-sync.yml');
    assert(existsSync(workflowPath), '.github/workflows/template-sync.yml 應該存在');

    const yaml = readFileSync(workflowPath, 'utf8');
    assert(/apply-template-update\.sh/.test(yaml), 'workflow 應該呼叫那支腳本');
    assert(/contents:\s*write/.test(yaml), 'workflow 需要 contents: write 才能推回自己的 repo');
    assert(/schedule:/.test(yaml), 'workflow 應該用排程自動跑');
    assert(/workflow_dispatch/.test(yaml), 'workflow 應該能手動觸發（排程被停用時的備援）');

    const gitCommandsInYaml = (yaml.match(/^\s+(git (reset|push|fetch|remote))/gm) || []).length;
    assertEqual(gitCommandsInYaml, 0, 'workflow 裡不應該有 git 同步指令（要放在腳本裡）');
  });

  check('.github/ 不會被同步覆蓋掉（排程不能把自己刪掉）', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts/apply-template-update.sh'), 'utf8');
    assert(/cp -R \.github/.test(script), '腳本應該把 .github/ 備份起來');
    assert(/rm -rf \.github/.test(script) && /cp -R "\$KEEP_DIR\/\.github" \.github/.test(script),
      '腳本應該在 reset 之後把 .github/ 還原回去');
  });

  // =========================================================================
  // 2. 研究室完全不用動手：排程會自己把新版拉過來
  // =========================================================================
  console.log('\n2. 研究室完全不用動手，新版自己到位');

  const labOrigin = makeBareOrigin(join(workRoot, 'lab-origin.git'));
  const template = makeTemplateRepo(join(workRoot, 'template'), { version: '1.0.0' });

  // 研究室部署的那一刻（範本還是 1.0.0）。
  const lab = makeLabRepo(join(workRoot, 'lab'), { origin: labOrigin, version: '1.0.0' });
  git(lab, ['push', '-q', '-u', 'origin', 'main']);

  // 維護者發布新版。
  setVersion(template, '1.1.0');
  writeFileSync(join(template, 'VERSION-NOTE.md'), 'template 1.1.0\n');
  writeFileSync(join(template, 'NEW-IN-1.1.md'), '新功能\n');
  git(template, ['add', '-A']);
  git(template, ['commit', '-q', '-m', 'v1.1.0']);

  check('研究室 repo 開頭是舊版，而且有 .github/workflows/', () => {
    assertEqual(readVersion(lab), '1.0.0', '一開始應該是 1.0.0');
    assert(existsSync(join(lab, '.github/workflows/template-sync.yml')),
      '研究室 repo 應該帶著 workflow（由範本複製過來）');
  });

  let synced = false;

  check('dry-run 只說明會做什麼，不會真的改', () => {
    const preview = runUpdate(lab, ['--upstream', template, '--dry-run']);
    assertEqual(preview.code, 0, `dry-run 應該成功，實際：${preview.stderr}`);
    assertEqual(readVersion(lab), '1.0.0', 'dry-run 不應該改版號');
    assert(/dry-run/.test(preview.stdout), 'dry-run 應該說明自己沒有推上去');
    assertEqual(git(lab, ['status', '--porcelain']), '', 'dry-run 之後工作區應該還是乾淨的');
  });

  check('跑一次同步之後，程式碼變成新版', () => {
    const result = runUpdate(lab, ['--upstream', template]);
    assertEqual(result.code, 0, `同步應該成功，實際：${result.stderr}`);
    synced = true;

    assertEqual(readVersion(lab), '1.1.0', '同步後應該是 1.1.0');
    assert(existsSync(join(lab, 'NEW-IN-1.1.md')), '新增的檔案應該出現');
    assert(readFileSync(join(lab, 'VERSION-NOTE.md'), 'utf8').includes('1.1.0'),
      '改過的檔案內容應該是新版');
  });

  check('.github/workflows/ 在同步後仍然存在', () => {
    assert(synced, '前一步的同步沒有成功，這項無法驗證');
    assert(existsSync(join(lab, '.github/workflows/template-sync.yml')),
      'workflow 檔應該被保留（否則自動更新只會發生一次）');
    const yaml = readFileSync(join(lab, '.github/workflows/template-sync.yml'), 'utf8');
    assert(/apply-template-update\.sh/.test(yaml), '保留的 workflow 應該還是完整的內容');
  });

  check('自動更新的 commit 作者是研究室的人，不是 bot', () => {
    // 這是整個機制最容易默默壞掉的地方：
    // Vercel 的原生 Git 整合會檢查 commit 作者是不是 Vercel 團隊成員，
    // 不是就直接擋掉部署，而且畫面上不會出現任何錯誤訊息。
    // 如果作者是 bot 信箱，網站會永遠停在舊版，而且查不出原因。
    assert(synced, '前一步的同步沒有成功，這項無法驗證');
    const email = git(lab, ['log', '-1', '--format=%ae']);
    assertEqual(email, 'pi@lab.example.edu',
      `自動更新的 commit 作者應該是研究室原本的作者，實際是 ${email}`);
    assert(!/bot|noreply/i.test(email), `作者不應該是 bot 信箱（會讓 Vercel 拒絕部署），實際：${email}`);
  });

  check('推送的差異裡沒有 .github/workflows/ 的變動（GITHUB_TOKEN 的限制）', () => {
    // GitHub 的 GITHUB_TOKEN 不能修改 .github/workflows/ 底下的檔案。
    // 腳本把 .github/ 原樣保留，所以推送時那些檔案完全不在差異裡。
    assert(synced, '前一步的同步沒有成功，這項無法驗證');
    const changed = git(lab, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
    const workflowChanges = changed.filter(file => file.startsWith('.github/workflows/'));
    assertEqual(workflowChanges.join(','), '',
      `推送內容不應該包含 workflow 檔（會被 GitHub 拒絕），發現：${workflowChanges.join(', ')}`);
  });

  check('同步結果真的推上了研究室的 GitHub（Vercel 才會有東西可部署）', () => {
    assert(synced, '前一步的同步沒有成功，這項無法驗證');
    const remoteHead = git(labOrigin, ['rev-parse', 'main']);
    const localHead = git(lab, ['rev-parse', 'HEAD']);
    assertEqual(remoteHead, localHead, '遠端 main 應該就是同步後的 commit');

    const remoteVersion = git(labOrigin, ['show', 'main:package.json']);
    assertEqual(JSON.parse(remoteVersion).version, '1.1.0', '遠端上的版號應該是 1.1.0');
  });

  check('更新前留了備份分支，出錯可以退回去', () => {
    // reset --hard 是不可逆的。研究室如果發現新版有問題，要有一條路退回舊版。
    assert(synced, '前一步的同步沒有成功，這項無法驗證');
    const backupBranches = git(labOrigin, ['branch', '--list', 'pre-update-backup']).trim();
    assert(backupBranches.includes('pre-update-backup'), '遠端應該有 pre-update-backup 分支');

    const backupVersion = git(labOrigin, ['show', 'pre-update-backup:package.json']);
    assertEqual(JSON.parse(backupVersion).version, '1.0.0', '備份分支應該是更新前的 1.0.0');
  });

  // =========================================================================
  // 3. 排程每天跑，所以要能安全地「什麼都不做」
  // =========================================================================
  console.log('\n3. 排程每天跑，所以要能安全地「什麼都不做」');

  check('已經是同一版時再跑一次，不會產生新 commit', () => {
    const beforeCommits = git(lab, ['rev-list', '--count', 'HEAD']);
    const result = runUpdate(lab, ['--upstream', template]);
    assertEqual(result.code, 0, `重跑應該成功結束，實際：${result.stderr}`);
    assert(/已是最新/.test(result.stdout), `應該說「已是最新」，實際輸出：${result.stdout}`);
    assertEqual(git(lab, ['rev-list', '--count', 'HEAD']), beforeCommits,
      '重跑不應該產生新的 commit（否則每天一個空 commit）');
  });

  check('研究室比範本新時，不會被降級', () => {
    // makeLabRepo 已經用 2.0.0 建好，所以直接加一個空 commit 表示「研究室動過」。
    const aheadLab = makeLabRepo(join(workRoot, 'ahead-lab'), { origin: labOrigin, version: '2.0.0' });
    git(aheadLab, ['commit', '-q', '--allow-empty', '-m', '研究室的版本比較新']);

    const result = runUpdate(aheadLab, ['--upstream', template]);
    assertEqual(result.code, 0, `應該正常結束，實際：${result.stderr}`);
    assert(/已是最新/.test(result.stdout), `應該說「已是最新」，實際：${result.stdout}`);
    assertEqual(readVersion(aheadLab), '2.0.0', '研究室的 2.0.0 不應該被降回 1.1.0');
  });

  check('超過 45 天沒 commit 時，留一個心跳 commit 維持排程', () => {
    // GitHub 會在公開 repo「60 天沒有活動」後自動停用排程 workflow，不通知。
    // 研究室平常不 commit，所以不補心跳的話自動更新會在兩個月後悄悄停止。
    const staleLab = makeLabRepo(join(workRoot, 'stale-lab'), { origin: labOrigin, version: '1.1.0' });
    git(staleLab, ['push', '-q', '-uf', 'origin', 'main']);
    ageLastCommit(staleLab, 50);

    const beforeCount = git(staleLab, ['rev-list', '--count', 'HEAD']);
    const result = runUpdate(staleLab, ['--upstream', template]);
    assertEqual(result.code, 0, `應該成功，實際：${result.stderr}`);
    assert(/心跳/.test(result.stdout), `應該說建立了心跳 commit，實際輸出：${result.stdout}`);
    assertEqual(git(staleLab, ['rev-list', '--count', 'HEAD']), String(Number(beforeCount) + 1),
      '應該多一個心跳 commit');

    // 心跳的 commit 時間要變成「現在」，才會重置 GitHub 的 60 天計時。
    const ageSeconds = Number(git(staleLab, ['log', '-1', '--format=%ct']));
    const nowSeconds = Math.floor(Date.now() / 1000);
    assert(nowSeconds - ageSeconds < 600, `心跳 commit 的時間應該是現在（差 ${nowSeconds - ageSeconds} 秒）`);
  });

  check('不到 45 天時不會亂發心跳', () => {
    const freshLab = makeLabRepo(join(workRoot, 'fresh-lab'), { origin: labOrigin, version: '1.1.0' });
    const beforeCount = git(freshLab, ['rev-list', '--count', 'HEAD']);
    const result = runUpdate(freshLab, ['--upstream', template]);
    assertEqual(result.code, 0, `應該成功，實際：${result.stderr}`);
    assert(!/心跳/.test(result.stdout), `不應該建立心跳（還很新），實際輸出：${result.stdout}`);
    assertEqual(git(freshLab, ['rev-list', '--count', 'HEAD']), beforeCount, '不應該產生 commit');
  });

  check('範本 repo 自己跑的時候會立刻結束（不會 reset 掉維護者的工作）', () => {
    // 交付副本是用 git archive 產生的，裡面沒有 .git —— 那就不是 git repo，
    // 沒有東西可以同步，應該安靜結束而不是報錯。這項也要驗。
    const isGitRepo = (() => {
      try {
        git(REPO_ROOT, ['rev-parse', '--git-dir']);
        return true;
      } catch {
        return false;
      }
    })();

    const selfVersionBefore = readVersion(REPO_ROOT);

    if (!isGitRepo) {
      const result = runUpdate(REPO_ROOT, ['--dry-run']);
      assertEqual(result.code, 0, `不是 git repo 時應該安靜結束，實際：${result.stderr}`);
      assert(/不是 git repo/.test(result.stdout),
        `應該說明這裡不是 git repo，實際輸出：${result.stdout}`);
      assertEqual(readVersion(REPO_ROOT), selfVersionBefore, '不應該動到檔案的版號');
      return;
    }

    const originUrl = git(REPO_ROOT, ['remote', 'get-url', 'origin']);
    const selfResult = runUpdate(REPO_ROOT, ['--upstream', originUrl, '--dry-run']);
    assertEqual(selfResult.code, 0, `應該正常結束，實際：${selfResult.stderr}`);
    assert(/就是範本本身/.test(selfResult.stdout),
      `應該認出「就是範本本身」，實際輸出：${selfResult.stdout}`);
    assertEqual(readVersion(REPO_ROOT), selfVersionBefore, '不應該動到範本的版號');
  });

  // =========================================================================
  // 4. 更新不會弄壞研究室的資料與設定
  // =========================================================================
  console.log('\n4. 更新不會弄壞研究室的資料與設定');

  check('同步不會刪掉研究室的 .env.local（本機執行時要用）', () => {
    const envLab = makeLabRepo(join(workRoot, 'env-lab'), { origin: labOrigin, version: '1.0.0' });
    writeFileSync(join(envLab, '.env.local'), 'SUPABASE_URL=https://lab.example.supabase.co\n');

    const result = runUpdate(envLab, ['--upstream', template, '--dry-run']);
    assertEqual(result.code, 0, `同步應該成功，實際：${result.stderr}`);
    assert(existsSync(join(envLab, '.env.local')), '研究室的 .env.local 不應該被同步刪掉');
    assertEqual(
      readFileSync(join(envLab, '.env.local'), 'utf8'),
      'SUPABASE_URL=https://lab.example.supabase.co\n',
      '.env.local 的內容不應該被改'
    );
  });

  check('有未提交的修改時拒絕同步（reset --hard 會弄丟東西）', () => {
    const dirtyLab = makeLabRepo(join(workRoot, 'dirty-lab'), { origin: labOrigin, version: '1.0.0' });
    writeFileSync(join(dirtyLab, 'index.html'), '<!-- 改到一半 -->\n');

    const result = runUpdate(dirtyLab, ['--upstream', template]);
    assertEqual(result.code, 5, `應該用結束碼 5 拒絕，實際：${result.code}`);
    assert(/未提交的修改/.test(result.stderr), `應該說明有未提交的修改，實際：${result.stderr}`);
    assertEqual(readFileSync(join(dirtyLab, 'index.html'), 'utf8'), '<!-- 改到一半 -->\n',
      '被拒絕時不應該動到檔案');
  });

  check('同步不含任何資料（資料在 Supabase，不在 repo 裡）', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts/apply-template-update.sh'), 'utf8');
    assert(!/rest\/v1|supabase\.co\/rest/.test(script), '同步腳本不應該碰資料庫（只換程式碼）');
    assert(!/DELETE FROM|TRUNCATE|drop table/i.test(script), '同步腳本不應該有任何刪資料的動作');
  });

  // =========================================================================
  // 5. 維護者要怎麼知道每間研究室更新了沒
  // =========================================================================
  console.log('\n5. 維護者看得出每間研究室的狀態');

  check('版本是唯一的比對依據（/api/health 看得到）', () => {
    const health = readFileSync(join(REPO_ROOT, 'api/health.js'), 'utf8');
    assert(/version:\s*APP_VERSION/.test(health), '/api/health 應該回版號');
    assert(/APP_VERSION/.test(readFileSync(join(REPO_ROOT, 'src/lib/app-info.js'), 'utf8')),
      'APP_VERSION 應該定義在 app-info.js');
  });

  check('文件寫出「研究室不用動手」這件事', () => {
    const handover = readFileSync(join(REPO_ROOT, 'docs/handover.md'), 'utf8');
    assert(/自動更新/.test(handover), '文件應該說明自動更新機制');
    assert(/apply-template-update\.sh|template-sync\.yml/.test(handover),
      '文件應該指出是哪支腳本／哪個 workflow 在做更新');
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
