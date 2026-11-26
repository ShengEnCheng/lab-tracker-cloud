#!/usr/bin/env bash
#
# 把範本（維護者那邊）的最新程式碼同步到這個 repo。
#
# ---------------------------------------------------------------------------
# 為什麼需要「拉」而不是「推」
# ---------------------------------------------------------------------------
# 一鍵部署時，Vercel 是把範本的程式碼「複製一份」到研究室自己的 GitHub，
# 兩邊是完全獨立的 repo（沒有共同祖先）。維護者對研究室的 repo 沒有任何寫入
# 權限 —— 所以沒辦法從範本那邊「推」更新給他們。
#
# 能做的是反過來：研究室的 repo 用自己的權限，從公開的範本「拉」更新。
# 這支腳本就是那段邏輯，由 .github/workflows/template-sync.yml 每天呼叫。
# 研究室完全不用動手。
#
# ---------------------------------------------------------------------------
# 為什麼邏輯在腳本裡，而不是寫在 workflow YAML 裡
# ---------------------------------------------------------------------------
# GitHub 的 GITHUB_TOKEN 不能修改 .github/workflows/ 底下的檔案（安全限制，
# 任何 permissions 設定都無法解開）。把邏輯放在這裡、YAML 只留一行呼叫，
# 以後要改同步邏輯時「不需要動 workflow 檔」，這個限制就永遠不會咬到。
#
# ---------------------------------------------------------------------------
# 三個容易被忽略、但會讓整個機制默默失效的細節
# ---------------------------------------------------------------------------
# 1. 保留 .github/：否則排程的 workflow 會把自己刪掉，自動更新只發生一次。
# 2. commit 的作者要用「研究室自己的身分」：Vercel 的原生 Git 整合會檢查
#    commit 作者是不是 Vercel 團隊成員，不是就直接擋掉部署（而且不會有任何
#    錯誤訊息）。用 bot 信箱會被擋，所以這裡沿用這個 repo 原本的作者。
# 3. 每 45 天留一個心跳 commit：GitHub 會在使用者「沒有任何活動」60 天後
#    自動停用排程 workflow（公開 repo 的規則），而且不會通知。研究室平常
#    不會 commit，所以不補心跳的話，兩個月後自動更新就會悄悄停止。
#
# ---------------------------------------------------------------------------
# 用法（平常由 GitHub Actions 呼叫，也可以自己在本機跑）
# ---------------------------------------------------------------------------
#   bash scripts/apply-template-update.sh
#   bash scripts/apply-template-update.sh --dry-run
#   bash scripts/apply-template-update.sh --upstream https://github.com/you/template.git
#
# 注意：這支腳本會 git reset --hard，而且「操作的是它自己所在的那個 repo」
# （不是目前所在的資料夾）。想在某個資料夾試跑，要用那個資料夾裡的那一份。
#
set -euo pipefail

DEFAULT_UPSTREAM="https://github.com/ShengEnCheng/lab-tracker-cloud.git"
BRANCH="main"
UPSTREAM_URL=""
DRY_RUN=0
FORCE=0

# 距離上次 commit 超過這麼多天，就留一個心跳 commit。
# GitHub 的門檻是 60 天，留 15 天緩衝（排程可能延遲或失敗幾次）。
KEEPALIVE_DAYS=45

usage() {
  cat <<'USAGE'
用法：bash scripts/apply-template-update.sh [選項]

  --upstream <網址>   範本的 repo 網址（預設讀 git remote 'upstream'）
  --branch <名稱>     要同步的分支（預設 main）
  --dry-run           只同步、不推上去（用來確認會發生什麼事）
  --force             本機有未提交的修改時仍然繼續（會被蓋掉）
  -h, --help          顯示這份說明

結束碼：
  0  已是最新，或同步完成
  2  參數錯誤
  4  同步後檢查失敗
  5  本機有未提交的修改，拒絕覆蓋
  6  看起來不是這個系統的 repo，拒絕更新
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知參數：$1" >&2; usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '%s\n' "$*"; }
fail() { printf '✘ %s\n' "$1" >&2; exit "${2:-4}"; }

# 讀某個版本點的 package.json 版號（讀不到就輸出空字串）。
version_at() {
  git show "$1" | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(text).version || "")); }
      catch { process.stdout.write(""); }
    });
  '
}

# 判斷 $1 是否比 $2 新（語意版號逐段比較）。
is_newer() {
  node -e '
    const parse = value => String(value).split(".").map(part => Number(part) || 0);
    const a = parse(process.argv[1]);
    const b = parse(process.argv[2]);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if ((a[i] || 0) !== (b[i] || 0)) {
        process.stdout.write((a[i] || 0) > (b[i] || 0) ? "1" : "0");
        process.exit(0);
      }
    }
    process.stdout.write("0");
  ' "$1" "$2"
}

normalize_url() {
  printf '%s' "$1" | sed -e 's#^git@github\.com:#https://github.com/#' -e 's#\.git$##' -e 's#/*$##'
}

# commit 要用的作者身分。
#
# 為什麼不是固定的 bot 信箱：Vercel 的原生 Git 整合在建立部署之前，會檢查
# commit 作者是不是該 Vercel 專案的團隊成員；不是就整筆擋掉，而且畫面上不會
# 出現任何錯誤（只會「什麼都沒發生」）。bot 信箱永遠不會是成員，所以改成沿用
# 這個 repo 最早那個 commit 的作者 —— 也就是當初按一鍵部署的人，他一定是有
# 權限的成員。
# 先找第一個 commit 的作者。找不到（例如 repo 是淺層複製）就退而求其次，
# 在歷史裡找第一個「看起來是人」的作者。
author_name=""
author_email=""
root_commit="$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1 || true)"
if [ -n "$root_commit" ]; then
  author_name="$(git show -s --format='%an' "$root_commit" 2>/dev/null || true)"
  author_email="$(git show -s --format='%ae' "$root_commit" 2>/dev/null || true)"
fi

if [ -z "$author_email" ] || printf '%s' "$author_email" | grep -qiE 'bot|noreply'; then
  # git log 由新到舊；找出第一個不是 bot 的作者。
  while IFS='|' read -r name email; do
    [ -z "$email" ] && continue
    printf '%s' "$email" | grep -qiE 'bot|noreply' && continue
    author_name="$name"
    author_email="$email"
    break
  done <<EOF
$(git log --format='%an|%ae' 2>/dev/null | head -50)
EOF
fi

author_name="${GIT_AUTHOR_NAME:-$author_name}"
author_email="${GIT_AUTHOR_EMAIL:-$author_email}"

# 真的找不到人，就不要用 bot 身分硬推。
#
# 為什麼要停在這裡：用 bot 信箱推上去，Vercel 會默默擋掉部署 —— 網站停在舊版，
# 沒有錯誤訊息、沒有通知，要等到有人發現功能不對才會知道。相反地，這裡失敗會
# 讓 Actions 顯示紅燈，至少看得到。寧可看得到的失敗，也不要看不到的失敗。
if [ -z "$author_email" ] || printf '%s' "$author_email" | grep -qiE 'bot|noreply'; then
  fail "找不到可以當 commit 作者的人。Vercel 不接受 bot 身分的 commit（會默默不部署）。
請設定 GIT_AUTHOR_NAME 與 GIT_AUTHOR_EMAIL 環境變數，指向一個有這個 Vercel
專案權限的帳號，再重跑。" 4
fi

commit_as_author() { # $1 = 訊息；其餘參數交給 git commit
  local message="$1"
  shift
  git -c "user.name=$author_name" -c "user.email=$author_email" commit "$@" -m "$message"
}

# ---------------------------------------------------------------------------
# 0. 安全檢查：這裡真的是要更新的那個 repo 嗎？
#
# 這支腳本會 git reset --hard。它操作的是「自己所在的那個 repo」，不是目前
# 所在的資料夾 —— 所以如果有人從別的資料夾呼叫這一份，被改的會是它自己住的
# repo。先確認這裡看起來就是這個系統，避免改錯地方。
# ---------------------------------------------------------------------------
if [ ! -f index.html ] || [ ! -f package.json ]; then
  fail "「$REPO_ROOT」看起來不是這個系統的 repo（找不到 index.html 或 package.json），拒絕更新" 6
fi

# 不是 git repo 就沒什麼好同步的（例如把專案解壓縮成一份純檔案來交付）。
# 這不是錯誤，安靜結束即可 —— 排程只在真正的 git checkout 裡執行。
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "這裡不是 git repo，沒有東西可以同步。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. 確認 upstream 在哪（先不動 remote，等自我檢查過再說）
# ---------------------------------------------------------------------------
if [ -z "$UPSTREAM_URL" ]; then
  if git remote get-url upstream >/dev/null 2>&1; then
    UPSTREAM_URL="$(git remote get-url upstream)"
  else
    # 沒有 upstream 時不要報錯停下 —— 用預設值。
    # 這是「自動更新」該有的樣子：研究室不需要先做任何設定。
    UPSTREAM_URL="$DEFAULT_UPSTREAM"
  fi
fi

log "範本：$UPSTREAM_URL"

# ---------------------------------------------------------------------------
# 2. 如果「這個 repo 就是範本」，什麼都不做。
#
# 這支腳本與它的 workflow 都在範本 repo 裡，所以範本自己也會被排程叫起來。
# 那個情況下 origin 與 upstream 是同一個地方 —— 同步自己沒有意義，而且會把
# 維護者正在改的東西 reset 掉。直接結束。
# ---------------------------------------------------------------------------
origin_url="$(git remote get-url origin 2>/dev/null || true)"
if [ -n "$origin_url" ] && [ "$(normalize_url "$origin_url")" = "$(normalize_url "$UPSTREAM_URL")" ]; then
  log "這個 repo 就是範本本身，不需要同步自己。"
  exit 0
fi

# 到這裡才真的建立／更新 upstream remote。
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
  log "已設定 upstream remote。"
fi

# ---------------------------------------------------------------------------
# 2b. 工作區必須是乾淨的。
#
# git reset --hard 會丟掉未提交的修改，而且救不回來。
# ---------------------------------------------------------------------------
if [ "$FORCE" != "1" ]; then
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    printf '✘ 這個 repo 有未提交的修改，同步會把它們蓋掉：\n\n' >&2
    printf '%s\n\n' "$dirty" >&2
    fail "請先 commit 或 stash；確定要放棄這些修改就加 --force" 5
  fi
fi

# ---------------------------------------------------------------------------
# 3. 取回範本，比版號
#
# 只有範本版號「比現在新」才更新。這道閘門是必要的：
#   · 重複執行要能安全地什麼都不做（排程每天跑，不能每天一個空 commit）
#   · 不會因為排程撞在一起就把新版降回舊版
# ---------------------------------------------------------------------------
git fetch --quiet upstream "$BRANCH"

if ! git rev-parse --verify --quiet "upstream/$BRANCH" >/dev/null; then
  fail "取不到 upstream/$BRANCH（repo 網址對嗎？分支名稱對嗎？）"
fi

current_version="$(version_at "HEAD:package.json")"
upstream_version="$(version_at "upstream/$BRANCH:package.json")"

if [ -z "$upstream_version" ]; then
  fail "範本的 package.json 讀不到版號，拒絕更新（避免把 repo 弄成半套）"
fi

log "現在版本：${current_version:-（讀不到）}"
log "範本版本：$upstream_version"

needs_update=0
if [ -z "$current_version" ] || [ "$(is_newer "$upstream_version" "$current_version")" = "1" ]; then
  needs_update=1
fi

# ---------------------------------------------------------------------------
# 4. 沒有新版時：留心跳 commit，避免排程在 60 天後被 GitHub 停用
#
# GitHub 的規則：公開 repo「沒有任何活動」60 天後，排程 workflow 會被自動
# 停用，而且不會通知（GitHub 文件：disabling-and-enabling-a-workflow）。
# 研究室平常不會 commit，所以不補心跳的話自動更新會在兩個月後默默死掉。
# ---------------------------------------------------------------------------
last_commit_epoch="$(git log -1 --format='%ct' 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
days_since=$(( (now_epoch - last_commit_epoch) / 86400 ))

if [ "$needs_update" = "0" ]; then
  if [ "$days_since" -lt "$KEEPALIVE_DAYS" ]; then
    log "已是最新（或比範本新），不需要更新。"
    exit 0
  fi

  log "已是最新，但距上次 commit 已 $days_since 天 —— 留一個心跳 commit 維持排程。"

  if [ "$DRY_RUN" = "1" ]; then
    log "（dry-run：沒有建立心跳 commit）"
    exit 0
  fi

  commit_as_author "chore: 維持自動更新的排程（心跳）" --allow-empty --quiet

  if ! git push --quiet origin "$BRANCH" 2>/dev/null; then
    log "推送心跳失敗，下次再試。"
    exit 0
  fi
  log "已推送心跳 commit。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. 同步程式碼，但保留 .github/ 與研究室的 .env
#
# 為什麼要保留 .github/：那是這個 repo 自己的自動化設定。整份蓋掉的話，
# 排程更新的 workflow 會把自己刪掉 —— 下次就不會再更新了。這也順便避開
# GitHub 的限制（GITHUB_TOKEN 不能改 .github/workflows/ 底下的檔案）：
# 因為原樣保留，推送的差異裡完全不會出現那些檔案。
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  # dry-run 只看「會不會更新」，不應該動到工作區 —— 否則確認用的預覽
  # 本身就已經把檔案改掉了，失去意義。
  log "（dry-run：會更新到 $upstream_version，工作區沒有被改動）"
  exit 0
fi

KEEP_DIR="$(mktemp -d)"
trap 'rm -rf "$KEEP_DIR"' EXIT

if [ -d .github ]; then
  cp -R .github "$KEEP_DIR/.github"
  kept_count="$(find "$KEEP_DIR/.github" -type f | wc -l | tr -d ' ')"
  log "保留 .github/（${kept_count} 個檔案）"
fi

# .env.local 之類的本機設定不能進版控、但也不該被刪掉（本機執行時會用到）。
for env_file in .env .env.local .env.production.local; do
  if [ -f "$env_file" ]; then
    cp "$env_file" "$KEEP_DIR/$env_file"
  fi
done

# 覆蓋之前先留一個可以回頭的點。
# 用固定的分支名稱，所以永遠只會有一條備份分支，不會越積越多。
previous_head="$(git rev-parse HEAD)"
if git push --quiet --force origin "$previous_head:refs/heads/pre-update-backup" 2>/dev/null; then
  log "已保留更新前的版本：分支 pre-update-backup"
else
  log "（無法保留更新前的版本，繼續）"
fi

git reset --hard "upstream/$BRANCH" >/dev/null

if [ -d "$KEEP_DIR/.github" ]; then
  rm -rf .github
  cp -R "$KEEP_DIR/.github" .github
fi
for env_file in .env .env.local .env.production.local; do
  if [ -f "$KEEP_DIR/$env_file" ]; then
    cp "$KEEP_DIR/$env_file" "$env_file"
  fi
done

git add -A

# 一律建立一個 commit，即使內容與範本完全相同。
#
# 為什麼不能「沒差異就不 commit」：這樣推上去的 HEAD 會是「範本的那個 commit」，
# 作者就是維護者。而 Vercel 的原生 Git 整合會檢查 commit 作者是不是團隊成員，
# 維護者不是這間研究室的成員 → 部署被擋，而且不會有任何錯誤訊息。
#
# 有了這個 commit，作者就會是研究室自己（見上面 author_email 的說明），
# Vercel 才會正常部署。
commit_as_author "chore: 自動更新到 $upstream_version" --allow-empty --quiet
log "已建立更新 commit（作者：$author_name <$author_email>）。"

# 自我檢查：套用後版號必須真的變成新版，否則不要推出去。
after_version="$(version_at "HEAD:package.json")"
if [ "$after_version" != "$upstream_version" ]; then
  fail "同步後版號是「$after_version」，但應該是「$upstream_version」—— 不推上去"
fi

# ---------------------------------------------------------------------------
# 6. 推回自己的 repo（Vercel 偵測到 push 就會重新部署）
#
# 用 --force-with-lease：兩邊沒有共同祖先，一定要覆寫；但加 lease 之後，
# 如果這段期間別人也推了東西，會停下來而不是硬蓋掉。
# ---------------------------------------------------------------------------
if ! git push --force-with-lease origin "$BRANCH" 2>/dev/null; then
  log "第一次推送失敗，重新取回遠端狀態再試一次…"
  git fetch --quiet origin "$BRANCH" || true
  git push --force-with-lease origin "$BRANCH"
fi

log "已推上去：$upstream_version（Vercel 會自動重新部署）"
