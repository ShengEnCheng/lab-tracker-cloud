// =============================================================================
// wizard.js — 雲端部署引導網頁的邏輯
//
// 這個檔案有兩個部分：
//   上半部：純函式（pure functions）。只吃參數、回傳結果，不碰網路也不碰 DOM。
//           這一半會被 Node 單元測試直接 import，所以必須完全獨立。
//   下半部：瀏覽器介面邏輯。全部收在 main() 裡面，只有 main() 會碰 document。
//
// 鐵則：模組最上層（top-level）絕對不能讀 document / window / localStorage，
//       否則 `node --input-type=module -e "await import('./wizard.js')"` 會直接爆掉。
//
// 名詞對照（給維護者）：
//   GitHub  = 放程式碼的地方（可以想成雲端的資料夾）
//   Vercel  = 把程式碼變成一個網址的地方（網站代管）
//   Supabase = 資料庫（放資料的地方）
// =============================================================================

import { TEMPLATE, WIZARD } from './config.js';

// -----------------------------------------------------------------------------
// 步驟定義
//
// 規格書把步驟編成 0～6，但畫面上給使用者看的是「第 1 步～第 7 步」。
// 內部一律用語意化的 id（start / github / deploy / database / schema / admin / done），
// 這樣程式碼比較好讀，也比較不會因為調整順序而出錯。
// -----------------------------------------------------------------------------

export const STEPS = [
  { id: 'start', number: 1, navLabel: '開始之前', panelTitle: '開始之前：你會得到什麼' },
  { id: 'github', number: 2, navLabel: '建立 GitHub 帳號', panelTitle: '建立一個 GitHub 帳號' },
  { id: 'deploy', number: 3, navLabel: '複製程式碼並部署', panelTitle: '把程式碼複製一份，變成你的網站' },
  { id: 'database', number: 4, navLabel: '建立資料庫', panelTitle: '建立資料庫（Supabase）' },
  { id: 'schema', number: 5, navLabel: '建立資料表', panelTitle: '在資料庫裡建立資料表' },
  { id: 'admin', number: 6, navLabel: '建立管理員帳號', panelTitle: '建立你自己的管理員帳號' },
  { id: 'done', number: 7, navLabel: '完成了', panelTitle: '完成了！' }
];

const STEP_IDS = STEPS.map(step => step.id);

// 允許 test 或外部程式用不同寫法指定步驟。這裡把它們都收斂成上面的 id。
// 注意：數字 0～6 一律照「規格書的編號」解讀（0 = 開始之前）。
const STEP_ALIASES = {
  '0': 'start', start: 'start', intro: 'start', begin: 'start',
  '1': 'github', github: 'github', githubaccount: 'github', account: 'github',
  '2': 'deploy', deploy: 'deploy', vercel: 'deploy', site: 'deploy',
  '3': 'database', database: 'database', supabase: 'database', db: 'database',
  '4': 'schema', schema: 'schema', tables: 'schema', sql: 'schema', migration: 'schema',
  '5': 'admin', admin: 'admin', account_setup: 'admin', setup: 'admin', owner: 'admin',
  '6': 'done', done: 'done', finish: 'done', complete: 'done', end: 'done'
};

/**
 * 把外部傳進來的步驟代號（可能是 'github'、'step-1'、1、'1'、'第2步'）轉成內部 id。
 * 認不出來就回傳 null。
 */
export function resolveStepId(stepId) {
  if (stepId === null || stepId === undefined) return null;
  if (typeof stepId === 'number' && Number.isFinite(stepId)) {
    return STEP_ALIASES[String(Math.trunc(stepId))] || null;
  }
  const raw = String(stepId).trim().toLowerCase();
  if (!raw) return null;
  if (STEP_ALIASES[raw]) return STEP_ALIASES[raw];
  // 支援 'step-1' / 'step1' 這種寫法（同樣照規格書編號）
  const m = raw.match(/^step[-_ ]?(\d+)$/);
  if (m) return STEP_ALIASES[m[1]] || null;
  return null;
}

// -----------------------------------------------------------------------------
// 第 1 個純函式：產生 Vercel Deploy Button 網址
// -----------------------------------------------------------------------------

/**
 * buildDeployUrl
 *
 * 產生「一鍵部署」按鈕要連過去的網址。這個網址會把使用者帶到 Vercel 的
 * 「複製這個 repo 到你的帳號並建立專案」流程。
 *
 * @param {object} options
 * @param {string} options.repoUrl        範本程式碼的公開 repo 網址（必填）
 * @param {string} [options.projectName]  Vercel 專案名稱（會自動清成合法字元）
 * @param {string} [options.repositoryName] 複製到使用者 GitHub 後的 repo 名稱
 * @param {string} [options.integrationId] Supabase 官方整合 ID（oac_ 開頭）
 * @returns {string} 形如 https://vercel.com/new/clone?repository-url=...
 */
export function buildDeployUrl({ repoUrl, projectName, repositoryName, integrationId } = {}) {
  const cleanRepoUrl = sanitizeRepoUrl(repoUrl);
  if (!cleanRepoUrl) {
    throw new TypeError('buildDeployUrl 需要一個有效的 repoUrl（例如 https://github.com/帳號/專案）');
  }

  const fallbackName = TEMPLATE.defaultProjectName || 'lab-tracker';
  // 專案名稱與 repo 名稱基本上是同一組東西，沒給的就互相補。
  const project = normalizeProjectSlug(projectName) || normalizeProjectSlug(repositoryName) || fallbackName;
  const repository = normalizeProjectSlug(repositoryName) || project;

  const params = new URLSearchParams();
  params.set('repository-url', cleanRepoUrl);
  params.set('project-name', project);
  params.set('repository-name', repository);

  const integration = typeof integrationId === 'string' ? integrationId.trim() : '';
  if (integration) {
    // integration-ids 是「必要的整合」。帶了這個參數，Vercel 會在部署流程中
    // 要求使用者連接 Supabase（這就是步驟 3 說的官方整合）。
    params.set('integration-ids', integration);
  }

  // external-id 只是給 Vercel 後台統計「這個部署從哪裡來的」，不影響功能。
  params.set('external-id', cleanRepoUrl);

  return `https://vercel.com/new/clone?${params.toString()}`;
}

function sanitizeRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return '';
  const text = repoUrl.trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!url.hostname.includes('.')) return '';
  // 去掉結尾斜線與 query/hash，保留 path。
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}`;
}

/**
 * 把使用者/維護者給的名字清成 Vercel 可以接受的格式：
 * 只能有小寫英文、數字、減號；不能有空白與中文。
 */
export function normalizeProjectSlug(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

// -----------------------------------------------------------------------------
// 第 2 個純函式：判斷某一步完成了沒
// -----------------------------------------------------------------------------

/**
 * evaluateStep
 *
 * 純邏輯，不發任何網路請求。網路請求由呼叫端（瀏覽器）做完之後，
 * 把結果整理成 observations 傳進來。
 *
 * @param {string|number} stepId  'github' / 'step-1' / 1 ...（見 resolveStepId）
 * @param {object} [observations] 觀察結果。欄位定義如下：
 *
 *   githubUserExists   {boolean} GitHub 帳號查得到
 *   githubRateLimited  {boolean} GitHub 說「查詢次數用完」（HTTP 403）
 *   supabaseUrlValid   {boolean} Supabase 網址格式正確（normalizeSupabaseUrl 有回東西）
 *   supabaseKeyPresent {boolean} 使用者有貼 publishable key
 *   supabaseReachable  {boolean} 打得到 Supabase（/auth/v1/health 有回應）
 *   supabaseKeyInvalid {boolean} Supabase 說金鑰不對（HTTP 401/403）
 *   schemaInstalled    {boolean} 資料表存在（interpretSchemaProbe 的結果）
 *   schemaReason       {string}  驗證失敗時，要秀給使用者看的具體原因
 *   siteUrlValid       {boolean} 網站網址格式正確
 *   siteReachable      {boolean} 打得開 /api/health
 *   siteHealthOk       {boolean} /api/health 回的內容符合這套系統
 *   siteBlockedByCors  {boolean} 被跨網域限制擋住（不是使用者的錯）
 *   setupComplete      {boolean} /api/setup-status 說設定都完成了
 *   setupUnreachable   {boolean} 打不到 /api/setup-status（可能是跨網域限制）
 *   setupReason        {string}  進度清單的補充說明
 *
 *   沒有提供（undefined）的欄位代表「還沒驗證過」→ 回 pending。
 *
 * @returns {{state: 'pass'|'fail'|'unknown'|'pending', message: string}}
 *
 *   四種狀態的意思（給 UI 決定顏色與圖示）：
 *     pass    ✔ 通過
 *     fail    ✖ 不通過，使用者要修正
 *     unknown ⚠ 看不出來（通常是跨網域限制或網路問題），不一定是錯
 *     pending … 還沒驗證過
 */
export function evaluateStep(stepId, observations = {}) {
  const id = resolveStepId(stepId);
  const obs = observations && typeof observations === 'object' ? observations : {};

  if (!id) {
    return {
      state: 'unknown',
      message: `我不認識「${String(stepId)}」這個步驟代號。請用 ${STEP_IDS.join(' / ')} 其中一個。`
    };
  }

  switch (id) {
    // ---------------------------------------------------------------- 開始之前
    case 'start':
      return {
        state: 'pass',
        message: '這一步只是說明，不需要驗證。看完按「下一步」就好。'
      };

    // ------------------------------------------------------------ 建立 GitHub 帳號
    case 'github': {
      if (obs.githubRateLimited === true) {
        return {
          state: 'unknown',
          message: 'GitHub 說「查詢次數超過今天的免費額度」，所以現在查不到。這不是你的問題，'
            + '請等大約 1 小時再按一次「驗證」；你也可以直接打開 https://github.com/ 看自己的首頁有沒出現。'
        };
      }
      if (obs.githubUserExists === true) {
        return { state: 'pass', message: '找到這個 GitHub 帳號了，這一步完成。' };
      }
      if (obs.githubUserExists === false) {
        return {
          state: 'fail',
          message: 'GitHub 找不到這個使用者名稱。請確認：(1) 拼字一模一樣、(2) 帳號註冊已經完成（要點過驗證信）、'
            + '(3) 你輸入的是「使用者名稱」不是 email。'
        };
      }
      return { state: 'pending', message: '還沒驗證。輸入使用者名稱後，按下面的「驗證」。' };
    }

    // ---------------------------------------------------------- 複製程式碼並部署
    case 'deploy': {
      if (obs.siteUrlValid === false) {
        return {
          state: 'fail',
          message: '這個網址看起來不完整。Vercel 給你的網址通常長得像 https://專案名稱.vercel.app，'
            + '請整段複製過來（前面要有 https://）。'
        };
      }
      if (obs.siteHealthOk === true) {
        return { state: 'pass', message: '連上了，而且回應的內容就是這套研究室系統。這一步完成。' };
      }
      if (obs.siteReachable === true) {
        return {
          state: 'unknown',
          message: '網頁打得開，但首頁沒有出現這套系統的健康檢查資訊。可能是：(1) 第一次部署還在進行（通常要 1～3 分鐘），'
            + '(2) 你貼的是 Vercel 後台網址而不是網站網址。請直接打開那個網址看看，有看到登入畫面就是成功了。'
        };
      }
      if (obs.siteBlockedByCors === true) {
        return {
          state: 'unknown',
          message: '我這邊看不到（跨網域限制，瀏覽器不讓我讀別的網站的內容）——這不代表你做錯。'
            + '如果你自己在瀏覽器打開那個網址看得到研究室系統，就是成功了，直接按「下一步」。'
        };
      }
      if (obs.siteReachable === false) {
        return {
          state: 'fail',
          message: '這個網址連不上。請確認網址沒有打錯，而且 Vercel 上面的部署狀態是 Ready。'
        };
      }
      return { state: 'pending', message: '還沒驗證。貼上 Vercel 給你的網址後，按「驗證」。' };
    }

    // ------------------------------------------------------------ 建立資料庫
    case 'database': {
      if (obs.supabaseUrlValid === false) {
        return {
          state: 'fail',
          message: 'Supabase 專案網址看起來不對。它應該長得像 https://abcdefgh.supabase.co'
            + '（在 Supabase 後台 Settings → API 找到）。'
        };
      }
      if (obs.supabaseKeyInvalid === true) {
        return {
          state: 'fail',
          message: 'Supabase 說這把金鑰（key）不對。請回 Supabase 後台 Settings → API Keys，'
            + '重新複製 sb_publishable_ 開頭的那一串，整段貼上，不要多空格。'
        };
      }
      if (obs.supabaseReachable === true) {
        if (obs.supabaseKeyPresent === false) {
          return {
            state: 'unknown',
            message: '資料庫連得到，但你還沒貼金鑰（key）。下一步建立資料表時會用到，建議先補上。'
          };
        }
        return { state: 'pass', message: '連上你的 Supabase 資料庫了，這一步完成。' };
      }
      if (obs.supabaseReachable === false) {
        return {
          state: 'unknown',
          message: '連不到這個資料庫。可能是網路不通，或 Supabase 專案還在建立中（新建專案要等 1～2 分鐘）。'
            + '請確認網路正常後再按一次「驗證」。'
        };
      }
      return { state: 'pending', message: '還沒驗證。貼上專案網址與金鑰後，按「驗證」。' };
    }

    // ------------------------------------------------------------ 建立資料表
    case 'schema': {
      if (obs.supabaseUrlValid === false) {
        return { state: 'fail', message: '還缺 Supabase 的專案網址。請先回上一步「建立資料庫」貼上並驗證。' };
      }
      if (obs.schemaInstalled === true) {
        return { state: 'pass', message: '資料表已經建好了，這一步完成。' };
      }
      if (obs.schemaInstalled === false) {
        const reason = typeof obs.schemaReason === 'string' && obs.schemaReason.trim()
          ? obs.schemaReason.trim()
          : '資料表還沒建立。';
        return { state: 'fail', message: reason };
      }
      return { state: 'pending', message: '還沒驗證。把建表語法貼到 Supabase 的 SQL Editor 跑完後，按「驗證」。' };
    }

    // -------------------------------------------------------- 建立管理員帳號
    case 'admin': {
      if (obs.setupComplete === true) {
        return { state: 'pass', message: '設定完成了。你的研究室系統已經可以開始用。' };
      }
      if (obs.setupComplete === false) {
        const reason = typeof obs.setupReason === 'string' && obs.setupReason.trim()
          ? ` ${obs.setupReason.trim()}`
          : '';
        return {
          state: 'fail',
          message: '系統說「還沒完成初始設定」。請打開你的網站，把「第一次使用」的表單填完'
            + '（研究室名稱、你的名字、email、至少 8 個字元的密碼）。' + reason
        };
      }
      if (obs.setupUnreachable === true) {
        return {
          state: 'unknown',
          message: '我這邊看不到（跨網域限制），無法確認設定完成沒。請直接打開你的網站：'
            + '如果看到的是正常的登入畫面、不再是「第一次使用」的表格，就是成功了。'
        };
      }
      return { state: 'pending', message: '還沒驗證。填完網站的「第一次使用」表單後，按「驗證」。' };
    }

    // ---------------------------------------------------------------- 完成
    case 'done': {
      if (obs.setupComplete === true) {
        return { state: 'pass', message: '全部完成了。把網址傳給同事，就可以開始用。' };
      }
      return {
        state: 'pending',
        message: '前面的步驟還沒全部通過。你還是可以把網址記下來，但建議先回去把沒打勾的步驟完成。'
      };
    }

    default:
      return { state: 'unknown', message: '這個步驟還沒有定義驗證方式。' };
  }
}

// -----------------------------------------------------------------------------
// 第 3 個純函式：整理 Supabase 專案網址
// -----------------------------------------------------------------------------

/**
 * normalizeSupabaseUrl
 *
 * 把使用者貼上的各種寫法收斂成 https://xxx.supabase.co。
 * 容忍：前後空白、外層的 <> 或引號、沒有 https://、尾巴多 /rest/v1/、
 *       最後的斜線、網址後面接了查詢字串。
 *
 * @param {string} input
 * @returns {string} 整理後的網址；看不懂就回空字串 ''
 */
export function normalizeSupabaseUrl(input) {
  if (typeof input !== 'string') return '';

  // 去掉頭尾空白，以及從後台複製時常一起帶到的 <>"' 字元。
  const text = input.trim().replace(/^[<"'`\s]+/, '').replace(/[>"'`\s]+$/, '');
  if (!text) return '';

  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // 沒有 https:// 前綴。只有長得像網域（含點、且是英數）才自動補上。
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+([/?#:]|$)/i.test(candidate)) {
      return '';
    }
    candidate = `https://${candidate}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  const hostname = url.hostname.toLowerCase();
  // 只接受純英數的網域名稱。像「隨便亂打」會被瀏覽器轉成 punycode，要在這裡擋掉。
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) return '';
  // 一定要有網域後綴（至少一個點），避免把 "abc" 當成網址。
  if (!hostname.includes('.')) return '';
  // 一定要是 supabase.co 結尾嗎？不強制，但常見的錯誤（貼到別家網址）就交下一步驗證去抓。

  return `https://${hostname}`;
}

/**
 * 把使用者貼上的網站網址整理成 https://xxx.vercel.app 這種形式。
 * 規則與 Supabase 類似，但允許帶路徑（有些人在子路徑下部署）。
 *
 * @param {string} input
 * @returns {string} 整理後的網址；看不懂回 ''
 */
export function normalizeSiteUrl(input) {
  if (typeof input !== 'string') return '';
  const text = input.trim().replace(/^[<"'`\s]+/, '').replace(/[>"'`\s]+$/, '');
  if (!text) return '';
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+([/?#:]|$)/i.test(candidate)) {
      return '';
    }
    candidate = `https://${candidate}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const hostname = url.hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `https://${hostname}${path}`;
}

// -----------------------------------------------------------------------------
// 金鑰（key）分類：擋掉「絕對不能貼進來」的那一種
//
// Supabase 有兩種金鑰，外觀只差前綴，但風險天差地遠：
//   sb_publishable_…  可以公開，本來就會出現在網頁程式裡 → 我們要這把
//   sb_secret_…       等於資料庫萬能鑰匙，能讀寫全部資料、繞過權限規則
//   舊式 service_role JWT 也屬於第二種。
//
// 這個引導頁會把使用者貼的金鑰放進請求標頭、也會存進 localStorage。
// 所以「貼錯成 secret key」時，我們必須在送出任何請求之前就擋下來並警告，
// 而不是默默幫他寄出去。這不是規格要求的函式，是為了安全額外加的。
// -----------------------------------------------------------------------------

const SECRET_KEY_RE = /(^sb_secret_)|(^sbp_)|(service_role)/i;

/**
 * 判斷使用者貼上的金鑰屬於哪一種。
 *
 * @param {string} input 使用者貼上的字串
 * @returns {{kind: 'publishable'|'secret'|'unknown'|'empty', message: string}}
 *   kind 是 'secret' 時，呼叫端一定要中止，不可送出請求。
 */
export function classifySupabaseKey(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) {
    return { kind: 'empty', message: '還沒貼金鑰（key）。' };
  }

  // JWT 形式（三段用點分隔）也可能是 service_role，要看內容。
  if (/^ey[A-Za-z0-9_-]+\./.test(text)) {
    try {
      if (typeof atob !== 'function') throw new Error('no atob');
      const payload = text.split('.')[1] || '';
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (json && json.role === 'service_role') {
        return {
          kind: 'secret',
          message: '這把是 service_role 金鑰，等於資料庫的萬能鑰匙。請立刻把它從這個欄位刪掉，'
            + '改用 sb_publishable_ 開頭的那把。'
        };
      }
      if (json && json.role === 'anon') {
        return { kind: 'publishable', message: '這是舊式的 anon 金鑰，可以用。' };
      }
    } catch {
      // 解析不出來就當作看不出來，交給伺服器判斷。
    }
    return { kind: 'unknown', message: '這像是一把 JWT 金鑰，但看不出是哪一種。' };
  }

  if (SECRET_KEY_RE.test(text)) {
    return {
      kind: 'secret',
      message: '這把看起來是「不能公開」的金鑰（sb_secret_ / service_role 系列）。'
        + '它有資料庫的完整權限，貼給任何人或任何網頁都可能讓整個研究室的資料被讀走或刪掉。'
    };
  }
  if (/^sb_publishable_/i.test(text)) {
    return { kind: 'publishable', message: '這是可以公開的 publishable 金鑰，正確。' };
  }
  return { kind: 'unknown', message: '這不像 Supabase 的金鑰格式（通常以 sb_publishable_ 開頭）。' };
}

// -----------------------------------------------------------------------------
// 第 4 個純函式：判斷資料表建好了沒
// -----------------------------------------------------------------------------

/**
 * interpretSchemaProbe
 *
 * 把「打 Supabase REST 探測資料表」的結果，翻譯成「資料表建好了沒」。
 *
 * 探測方式（在瀏覽器裡發的請求，不是這個函式發的）：
 *   GET <supabaseUrl>/rest/v1/lab_state?select=id&limit=1
 *   headers: { apikey: <publishable key> }
 *
 * 為什麼 200 但內容是空陣列也算成功：
 *   資料表存在 → PostgREST 就會回 200。但 lab_state 開了 RLS（列級權限），
 *   未登入的匿名使用者讀不到任何一列，所以內容是 []。
 *   也就是說「表存在」和「有資料」是兩件事，這一步只驗證前者。
 *   （同理：migration 裡沒有插入初始資料列，那一列是使用者第一次完成設定時才建立的。）
 *
 * @param {object} probe
 * @param {number} probe.status HTTP 狀態碼（0 代表連線失敗）
 * @param {*}      [probe.body] 回應內容（物件、陣列、或字串都可以）
 * @param {string} [probe.tableName] 要探測的資料表名稱，預設 'lab_state'
 * @returns {{schemaInstalled: boolean, reason: string}}
 */
export function interpretSchemaProbe({ status, body, tableName } = {}) {
  const table = typeof tableName === 'string' && tableName.trim()
    ? tableName.trim()
    : (WIZARD.schemaProbeTable || 'lab_state');

  const parsed = normalizeBody(body);
  const bodyText = stringifyBody(parsed);
  const code = extractCode(parsed, bodyText);
  const numericStatus = Number(status);

  // ---------------------------------------------------------------- 連線失敗
  if (!Number.isFinite(numericStatus) || numericStatus === 0) {
    return {
      schemaInstalled: false,
      reason: '連不到你的資料庫（網路不通）。請確認網路正常，或 Supabase 專案是不是還在啟動中，稍後再試。'
    };
  }

  // ------------------------------------------------------------------- 成功
  if (numericStatus === 200) {
    const rowCount = Array.isArray(parsed) ? parsed.length : null;
    const countNote = rowCount === 0
      ? '（回應是空的 []，這是正常的：資料表存在，但沒登入的人依權限規則讀不到任何一列。）'
      : rowCount === null
        ? '（回應不是陣列，但狀態碼正常。）'
        : `（回應有 ${rowCount} 列。）`;
    return {
      schemaInstalled: true,
      reason: `資料表「${table}」已經建好了。${countNote}`
    };
  }

  // --------------------------------------------------------------- 找不到表
  // PostgREST 找不到資料表時回 404 + code PGRST205。
  if (numericStatus === 404 && code === 'PGRST205') {
    return {
      schemaInstalled: false,
      reason: `資料表「${table}」還沒建立。請把上面的建表語法整段複製，貼到 Supabase 左邊選單的 SQL Editor，按 RUN 跑一次。`
    };
  }
  if (numericStatus === 404) {
    return {
      schemaInstalled: false,
      reason: `資料庫說找不到「${table}」相關的東西（HTTP 404）。最可能是資料表還沒建立——`
        + '請把上面的建表語法貼到 SQL Editor 跑一次。如果你確定跑過了，請確認貼上的建表語法沒有被截斷。'
    };
  }

  // --------------------------------------------------------------- 金鑰有問題
  if (numericStatus === 401) {
    return {
      schemaInstalled: false,
      reason: '資料庫說這把金鑰（key）不正確（HTTP 401）。請回 Supabase 後台 Settings → API Keys，'
        + '重新複製 sb_publishable_ 開頭的那一串，整段貼上、不要有空格或換行。'
    };
  }
  if (numericStatus === 403) {
    return {
      schemaInstalled: false,
      reason: '資料庫拒絕了這個請求（HTTP 403）。通常是金鑰（key）貼錯、或這把 key 的權限不足。'
        + '請確認你貼的是 sb_publishable_ 開頭的金鑰，而且沒有貼到 secret 金鑰。'
    };
  }

  // ------------------------------------------------------------- 其他狀況
  return {
    schemaInstalled: false,
    reason: `資料庫回了看不懂的結果（HTTP ${numericStatus}）。`
      + (bodyText ? `內容開頭是：${bodyText}` : '（沒有內容）')
  };
}

function normalizeBody(body) {
  if (typeof body !== 'string') return body;
  const text = body.trim();
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyBody(body) {
  if (body === null || body === undefined) return '';
  let text;
  if (typeof body === 'string') text = body;
  else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function extractCode(parsed, bodyText) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.code === 'string') {
    return parsed.code.toUpperCase();
  }
  const match = String(bodyText).match(/PGRST\d+/i);
  return match ? match[0].toUpperCase() : '';
}

// -----------------------------------------------------------------------------
// 第 5 個純函式：把 /api/setup-status 的回應翻成進度清單
// -----------------------------------------------------------------------------

// 沒收到明確清單時，用這組「這套系統一定會有的設定項目」來推斷。
const DEFAULT_SETUP_STEPS = [
  {
    id: 'backend',
    label: '網站已接上資料庫（後端連線設定完成）',
    read: payload => firstBoolean(payload, ['ready', 'backendConfigured', 'supabaseConfigured', 'configured', 'databaseConfigured']),
    detail: 'Vercel 有沒有把 Supabase 的金鑰自動填好。'
  },
  {
    id: 'schema',
    label: '資料表已建立',
    read: payload => firstBoolean(payload, ['schemaInstalled', 'tablesReady', 'databaseReady', 'dbReady', 'schemaReady']),
    detail: '資料庫裡有沒有這套系統要用的資料表。'
  },
  {
    id: 'admin',
    label: '管理員帳號已建立',
    read: payload => firstBoolean(payload, ['adminExists', 'hasAdmin', 'ownerExists', 'adminReady']),
    detail: '有沒有一個可以登入的管理員。'
  },
  {
    id: 'data',
    label: '資料庫已有初始資料',
    read: payload => firstBoolean(payload, ['dataInitialized', 'stateRowExists', 'initialized', 'labStateExists']),
    detail: '「第一次使用」的表單填完後才會出現的那一列資料。'
  }
];

// api/setup-status.js 的 checks 物件裡，每一項的代號與中文標籤。
// 原始碼註解明確說「呼叫端（引導網頁）會固定讀 checks.environment.ok」，
// 所以這裡的 id 要跟它對得上。
//
// 標籤刻意寫成「名詞」而不是「已完成的句子」（例如寫「資料表」而不是「資料表已建立」），
// 因為同一個標籤會用在兩種地方：
//   已完成 → ✔ 資料表
//   未完成 → 還沒完成的是：資料表
// 若寫成「資料表已建立」，第二種就會變成「還沒完成的是：資料表已建立」，讀起來前後矛盾。
const SETUP_CHECK_LABELS = [
  { id: 'environment', label: '網站與資料庫的連線設定', hint: 'Vercel 還沒把 Supabase 的金鑰填好。' },
  { id: 'database', label: '資料庫連線', hint: '連不到資料庫。' },
  { id: 'schema', label: '資料表', hint: '資料庫裡還缺這套系統要用的資料表。' },
  { id: 'setup', label: '管理員帳號與初始設定', hint: '還沒有人建立管理員帳號。' }
];

/**
 * interpretSetupStatus
 *
 * 把 /api/setup-status 的回應，整理成「給人看的進度清單」。
 *
 * 這個端點還沒定稿，所以這裡刻意寫得寬容：接受幾種常見的回應形狀，
 * 認不出來的欄位就當作「不確定」，不會因此說使用者做錯。
 *
 * 接受的形狀（由寬到窄）：
 *   1. { steps: [{ id, label, ok, detail }] }        ← 最理想
 *   2. { checks: [...] } 或直接是陣列
 *   3. { ready, schemaInstalled, adminExists, ... }  ← 散落的布林值
 *   4. { allDone } / { setupComplete }               ← 只有總結
 *
 * @param {*} payload /api/setup-status 的 JSON 內容
 * @returns {{steps: Array<{id: string, label: string, ok: boolean, detail: string}>, allDone: boolean}}
 */
export function interpretSetupStatus(payload) {
  const empty = { steps: [], allDone: false };

  // 把「一堆可能的包裝」拆掉，例如 { setup: {...} }、{ status: {...} }。
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return empty;
    }
  }
  if (!data || typeof data !== 'object') return empty;
  if (data.setup && typeof data.setup === 'object') data = data.setup;
  else if (data.status && typeof data.status === 'object' && !Array.isArray(data.status)) data = data.status;

  // ---- 形狀 1/2：直接就是清單
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.steps)
      ? data.steps
      : Array.isArray(data.checks)
        ? data.checks
        : null;

  if (list) {
    const steps = list
      .map((item, index) => normalizeSetupStep(item, index))
      .filter(Boolean);
    return { steps, allDone: steps.length > 0 && steps.every(step => step.ok) };
  }

  // ---- 形狀 3：{ checks: { environment: {ok,message}, database: {...}, schema: {...}, setup: {...} } }
  //
  // 這是 api/setup-status.js 實際會回的形狀（2026-11 之後的版本）。
  // 注意 checks 是「物件」不是陣列，每一項只有 {ok, message}，沒有 id / label，
  // 所以標籤由下面這張表提供。缺的項目代表伺服器還沒走到那一關（它會提早 return），
  // 那就不要列出這一項，免得讓人以為那一項「失敗」。
  if (data.checks && typeof data.checks === 'object' && !Array.isArray(data.checks)) {
    const steps = [];
    for (const definition of SETUP_CHECK_LABELS) {
      const raw = data.checks[definition.id];
      if (raw === undefined || raw === null) continue;
      const ok = typeof raw === 'object' ? toBoolean(raw.ok) : toBoolean(raw);
      const message = typeof raw === 'object' && typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim()
        : '';
      steps.push({
        id: definition.id,
        label: definition.label,
        ok,
        detail: message || (ok ? '已完成。' : definition.hint)
      });
    }
    const summary = firstBoolean(data, ['allDone', 'setupComplete', 'complete', 'setupDone']);
    const allDone = summary !== undefined ? summary : steps.length > 0 && steps.every(step => step.ok);
    if (steps.length > 0) {
      // 有總結欄位就以它為準（伺服器知道得比我們多）；
      // 沒有的話，全部項目都 ok 才算完成。
      return { steps, allDone };
    }
  }

  // ---- 形狀 4：從散落的欄位拼出來
  const steps = [];
  for (const definition of DEFAULT_SETUP_STEPS) {
    const value = definition.read(data);
    if (value === undefined) continue; // 這個部署沒提供這個資訊，不要亂猜
    steps.push({
      id: definition.id,
      label: definition.label,
      ok: value,
      detail: value ? '已完成。' : `${definition.detail}還沒完成。`
    });
  }

  // 總結欄位。如果伺服器直接給了 allDone / setupComplete，以它為準。
  const summary = firstBoolean(data, ['allDone', 'setupComplete', 'complete', 'setupDone', 'fullySetup']);
  if (steps.length === 0) {
    if (summary === undefined) return empty;
    return {
      steps: [{
        id: 'setup',
        label: '系統已完成初始設定',
        ok: summary,
        detail: summary ? '伺服器說設定完成了。' : '伺服器說設定還沒完成。'
      }],
      allDone: summary
    };
  }

  const allDone = summary !== undefined ? summary : steps.every(step => step.ok);
  return { steps, allDone };
}

function normalizeSetupStep(item, index) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `step-${index + 1}`;
  const label = typeof item.label === 'string' && item.label.trim()
    ? item.label.trim()
    : (typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `第 ${index + 1} 項`);
  const rawOk = firstBoolean(item, ['ok', 'done', 'complete', 'passed', 'ready', 'success']);
  const failed = firstBoolean(item, ['failed', 'error']) === true;
  let ok;
  if (rawOk !== undefined) ok = rawOk;
  else if (typeof item.status === 'string') ok = /^(ok|pass|passed|done|complete|ready|success)$/i.test(item.status.trim());
  else ok = !failed;
  const detail = typeof item.detail === 'string' && item.detail.trim()
    ? item.detail.trim()
    : (typeof item.message === 'string' ? item.message.trim() : '');
  return { id, label, ok: Boolean(ok), detail };
}

function firstBoolean(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (['true', 'ok', 'yes', 'done', 'ready', 'complete', 'completed'].includes(text)) return true;
      if (['false', 'no', 'error', 'failed', 'pending', 'missing'].includes(text)) return false;
    }
    if (typeof value === 'number') return value > 0;
  }
  return undefined;
}

// 單一個值的寬容布林轉換。認不出來就當成 false（寧可說「還沒完成」，
// 也不要騙使用者說好了）。
function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'ok', 'yes', 'done', 'ready', 'complete', 'completed', 'pass', 'passed', 'success'].includes(text)) return true;
    return false;
  }
  if (typeof value === 'number') return value > 0;
  return Boolean(value);
}

export { DEFAULT_SETUP_STEPS };

// -----------------------------------------------------------------------------
// 小工具：把 fetch 的錯誤分類
// -----------------------------------------------------------------------------

/**
 * classifyFetchError
 *
 * 把 fetch 丟出來的錯誤分成三種，因為「網路不通」和「設定錯誤」要分開講。
 *
 * @param {*} error fetch 丟出的錯誤
 * @returns {{kind: 'timeout'|'blocked'|'network', message: string}}
 *   timeout = 等太久；blocked = 被跨網域限制擋住（檔案直接開啟時很常見）；
 *   network = 其他網路問題
 */
export function classifyFetchError(error) {
  const name = error && error.name ? String(error.name) : '';
  const message = error && error.message ? String(error.message) : '';

  if (name === 'AbortError' || /abort/i.test(message)) {
    return {
      kind: 'timeout',
      message: `等了 ${Math.round((WIZARD.requestTimeoutMs || 12000) / 1000)} 秒都沒有回應，應該是網路太慢或不通。`
    };
  }
  // 跨網域限制與「真的連不上」在瀏覽器裡都是 TypeError，無法完全區分。
  // 這裡一律歸成 blocked/network 混合，文案會提醒使用者「可能是跨網域限制」。
  return {
    kind: 'blocked',
    message: '瀏覽器不讓我讀那個網址的內容（可能是跨網域限制，也可能是網路不通）。'
  };
}

/**
 * 判斷某個步驟是否「建議先完成上一步」。
 * 使用者可以自由跳步驟，但 UI 會在用前面步驟還沒通過時給一句提醒。
 *
 * @param {string|number} stepId
 * @param {object} states  { [stepId]: 'pass'|'fail'|'unknown'|'pending' }
 * @returns {{ok: boolean, message: string}}
 */
export function getStepPrerequisite(stepId, states = {}) {
  const id = resolveStepId(stepId);
  const index = STEP_IDS.indexOf(id);
  if (index <= 0) return { ok: true, message: '' };

  const missing = [];
  for (let i = 0; i < index; i += 1) {
    const previousId = STEP_IDS[i];
    if (previousId === 'start') continue;
    if (states && states[previousId] === 'pass') continue;
    missing.push(STEPS[i].navLabel);
  }
  if (missing.length === 0) return { ok: true, message: '' };
  return {
    ok: false,
    message: `建議先完成前面的步驟：${missing.join('、')}。你現在也可以先看，之後再回來補。`
  };
}

// =============================================================================
// 以下是瀏覽器介面邏輯。全部收在 main() 裡，Node import 這個模組時完全不會執行。
// =============================================================================

const STORAGE_KEY = 'lab-tracker-deployment-wizard:v1';

// 只有這些欄位會被寫進 localStorage。publishable key 是「可以公開」的金鑰，
// 但我們仍然只把它存在使用者自己的瀏覽器裡，不出現在任何檔案中。
const PERSISTED_FIELDS = ['githubUsername', 'siteUrl', 'supabaseUrl', 'publishableKey'];

function createEmptyState() {
  return {
    currentStep: 'start',
    githubUsername: '',
    siteUrl: '',
    supabaseUrl: '',
    publishableKey: '',
    // 每一步最後一次的驗證結果：{ state, message, at }
    verifications: {},
    // 使用者手動按過「下一步」的紀錄（用來算進度）
    visited: { start: true }
  };
}

/**
 * main
 *
 * 瀏覽器進入點。只有在 typeof document !== 'undefined' 時才會被呼叫。
 */
function main() {
  const doc = document;
  const state = loadState();

  const elements = collectElements(doc);
  if (!elements.root) return;

  buildNavigation(elements, state);
  bindFieldInputs(elements, state);
  bindCopyButtons(elements, doc);
  bindVerifyButtons(elements, state);

  renderMigrationSql(elements, doc);
  renderDeploySection(elements);
  bindNavigation(elements, state);
  bindResetButton(elements, state);

  applyStateToForm(elements, state);
  showStep(elements, state, resolveStepId(state.currentStep) || 'start', { scroll: false });

  // 讓使用者知道「驗證過的結果重新整理後還在」，以及 key 只留在本機。
  const storageWarning = doc.getElementById('storageWarning');
  if (storageWarning) storageWarning.hidden = !isStorageAvailable();

  // 標記「這個引導頁已經跑起來了」。
  // index.html 的啟動器會看這個旗標，避免同一頁跑兩次 main()：
  // 正常情況（http/https）載入 wizard.js 就跑起來；雙擊開啟（file://）時
  // 瀏覽器不准載入模組檔，改由 inline-bundle.js 的內嵌副本執行，
  // 兩條路只會有一條成功，旗標用來確認與除錯。
  window.__WIZARD_STARTED__ = true;
}

function collectElements(doc) {
  return {
    root: doc.getElementById('wizardApp'),
    nav: doc.getElementById('stepNav'),
    progress: doc.getElementById('progressFill'),
    progressText: doc.getElementById('progressText'),
    panels: Array.from(doc.querySelectorAll('[data-panel]')),
    resetButton: doc.getElementById('resetButton'),
    deployLink: doc.getElementById('deployLink'),
    deployUrlText: doc.getElementById('deployUrlText'),
    doneUrl: doc.getElementById('doneUrl'),
    doneSiteUrlHint: doc.getElementById('doneSiteUrlHint'),
    doneUrlLink: doc.getElementById('doneUrlLink')
  };
}

// -----------------------------------------------------------------------------
// 狀態存取
// -----------------------------------------------------------------------------

function isStorageAvailable() {
  try {
    const probe = '__wizard_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function loadState() {
  const empty = createEmptyState();
  if (typeof window === 'undefined' || !window.localStorage) return empty;
  let raw;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const merged = { ...empty };
  for (const field of PERSISTED_FIELDS) {
    if (typeof parsed[field] === 'string') merged[field] = parsed[field];
  }
  if (typeof parsed.currentStep === 'string' && resolveStepId(parsed.currentStep)) {
    merged.currentStep = resolveStepId(parsed.currentStep);
  }
  if (parsed.verifications && typeof parsed.verifications === 'object') {
    for (const [key, value] of Object.entries(parsed.verifications)) {
      const id = resolveStepId(key);
      if (!id || !value || typeof value !== 'object') continue;
      if (!['pass', 'fail', 'unknown', 'pending'].includes(value.state)) continue;
      merged.verifications[id] = {
        state: value.state,
        message: typeof value.message === 'string' ? value.message : '',
        at: typeof value.at === 'number' ? value.at : 0
      };
    }
  }
  if (parsed.visited && typeof parsed.visited === 'object') {
    for (const key of Object.keys(parsed.visited)) {
      const id = resolveStepId(key);
      if (id) merged.visited[id] = true;
    }
  }
  return merged;
}

function saveState(state) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 滿了或被瀏覽器封鎖（例如無痕模式）。不影響當次使用。
  }
}

// -----------------------------------------------------------------------------
// 側邊欄與切換步驟
// -----------------------------------------------------------------------------

function buildNavigation(elements, state) {
  if (!elements.nav) return;
  const fragment = document.createDocumentFragment();

  STEPS.forEach(step => {
    const item = document.createElement('li');
    item.className = 'step-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-button';
    button.dataset.navStep = step.id;
    button.innerHTML = `
      <span class="step-number" aria-hidden="true">${step.number}</span>
      <span class="step-label">${escapeHtml(step.navLabel)}</span>
      <span class="step-check" aria-hidden="true"></span>
    `;
    button.setAttribute('aria-label', `第 ${step.number} 步：${step.navLabel}`);
    item.appendChild(button);
    fragment.appendChild(item);
  });

  elements.nav.innerHTML = '';
  elements.nav.appendChild(fragment);

  elements.nav.addEventListener('click', event => {
    const button = event.target.closest('[data-nav-step]');
    if (!button) return;
    showStep(elements, state, button.dataset.navStep, { scroll: true });
  });
}

function bindNavigation(elements, state) {
  // 面板裡的「下一步 / 上一步 / 開始」按鈕
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-goto]');
    if (trigger) {
      showStep(elements, state, trigger.dataset.goto, { scroll: true });
      return;
    }
    const prev = event.target.closest('[data-nav-prev]');
    if (prev) {
      const index = STEP_IDS.indexOf(resolveStepId(state.currentStep));
      if (index > 0) showStep(elements, state, STEP_IDS[index - 1], { scroll: true });
      return;
    }
    const next = event.target.closest('[data-nav-next]');
    if (next) {
      const index = STEP_IDS.indexOf(resolveStepId(state.currentStep));
      if (index >= 0 && index < STEP_IDS.length - 1) showStep(elements, state, STEP_IDS[index + 1], { scroll: true });
    }
  });
}

function showStep(elements, state, stepId, { scroll = true } = {}) {
  const id = resolveStepId(stepId) || 'start';
  state.currentStep = id;
  state.visited[id] = true;
  saveState(state);

  elements.panels.forEach(panel => {
    const isActive = panel.dataset.panel === id;
    panel.hidden = !isActive;
    panel.classList.toggle('is-active', isActive);
  });

  // 側邊欄標記
  if (elements.nav) {
    elements.nav.querySelectorAll('[data-nav-step]').forEach(button => {
      const target = resolveStepId(button.dataset.navStep);
      const isActive = target === id;
      button.classList.toggle('is-current', isActive);
      button.setAttribute('aria-current', isActive ? 'step' : 'false');

      const verification = state.verifications[target];
      const passed = verification && verification.state === 'pass';
      button.classList.toggle('is-done', Boolean(passed));
      const check = button.querySelector('.step-check');
      if (check) check.textContent = passed ? '✔' : '';
    });
  }

  // 進度
  updateProgress(elements, state);

  // 建議先完成上一步的提醒
  const panel = elements.panels.find(item => item.dataset.panel === id);
  if (panel) {
    const states = mapVerificationStates(state);
    const prerequisite = getStepPrerequisite(id, states);
    const banner = panel.querySelector('[data-prerequisite]');
    if (banner) {
      banner.hidden = prerequisite.ok;
      if (!prerequisite.ok) banner.textContent = prerequisite.message;
    }
  }

  if (scroll) {
    const target = typeof window !== 'undefined' ? window : null;
    if (target && typeof target.scrollTo === 'function') target.scrollTo({ top: 0, behavior: 'auto' });
  }
}

function mapVerificationStates(state) {
  const states = {};
  for (const step of STEPS) {
    const verification = state.verifications[step.id];
    states[step.id] = verification ? verification.state : 'pending';
  }
  return states;
}

function updateProgress(elements, state) {
  // 「開始之前」與「完成了」都不是要做的事，只是說明頁與收尾頁，
  // 不列入進度分母。
  //
  // 為什麼一定要排除「完成了」：它雖然也有「再檢查一次」按鈕，
  // 但那不是使用者該做的任務。把它算進分母的話，使用者做完全部五件事
  // 之後進度條只會停在 5/6，看起來像「還有一件事沒做」，
  // 於是回頭把每一步再點一次——但其實他已經做完了。
  const NON_TASK_STEPS = new Set(['start', 'done']);
  const countable = STEPS.filter(step => !NON_TASK_STEPS.has(step.id));
  const total = countable.length;
  const done = countable.filter(step => {
    const verification = state.verifications[step.id];
    return verification && verification.state === 'pass';
  }).length;

  if (elements.progress) {
    elements.progress.style.width = `${Math.round((done / total) * 100)}%`;
  }
  if (elements.progressText) {
    elements.progressText.textContent = `已完成 ${done} / ${total} 步`;
  }
  // 無障礙屬性也要跟著更新。HTML 裡寫死 aria-valuemax="6"，
  // 但實際的任務數是 5 —— 讀螢幕的人會聽到「已完成 5 / 6」，
  // 跟他看到的 5/5 不一致，會以為還有一件事沒做。
  if (elements.progress && elements.progress.parentElement) {
    elements.progress.parentElement.setAttribute('aria-valuemax', String(total));
    elements.progress.parentElement.setAttribute('aria-valuenow', String(done));
  }
}

// -----------------------------------------------------------------------------
// 表單欄位
// -----------------------------------------------------------------------------

function bindFieldInputs(elements, state) {
  const fields = document.querySelectorAll('[data-field]');
  fields.forEach(field => {
    field.addEventListener('input', () => {
      const name = field.dataset.field;
      if (!PERSISTED_FIELDS.includes(name)) return;
      state[name] = field.value;
      saveState(state);
      // 使用者改了內容，舊的驗證結果就不算數了。
      const stepId = field.dataset.fieldStep ? resolveStepId(field.dataset.fieldStep) : null;
      if (stepId && state.verifications[stepId]) {
        delete state.verifications[stepId];
        saveState(state);
        clearResult(elements, stepId);
        updateNavChecks(elements, state);
        updateProgress(elements, state);
      }
      syncDynamicText(elements, state);
    });
  });
}

function applyStateToForm(elements, state) {
  document.querySelectorAll('[data-field]').forEach(field => {
    const name = field.dataset.field;
    if (PERSISTED_FIELDS.includes(name)) field.value = state[name] || '';
  });
  syncDynamicText(elements, state);
  // 把上次的驗證結果顯示回來
  for (const step of STEPS) {
    const verification = state.verifications[step.id];
    if (!verification) continue;
    renderResult(elements, step.id, verification.state, verification.message);
  }
  updateNavChecks(elements, state);
  updateProgress(elements, state);
}

function updateNavChecks(elements, state) {
  if (!elements.nav) return;
  elements.nav.querySelectorAll('[data-nav-step]').forEach(button => {
    const target = resolveStepId(button.dataset.navStep);
    const verification = state.verifications[target];
    const passed = verification && verification.state === 'pass';
    button.classList.toggle('is-done', Boolean(passed));
    const check = button.querySelector('.step-check');
    if (check) check.textContent = passed ? '✔' : '';
  });
}

function syncDynamicText(elements, state) {
  // 側邊欄與其他用「目前值」組字的地方（之後要加可以放這裡）
  const siteUrl = normalizeSiteUrl(state.siteUrl);
  if (elements.doneSiteUrlHint) {
    // 第 7 步說明自動更新的那張卡片要顯示使用者自己的網址，
    // 否則他得回去前面找 —— 而這裡正是他準備去設定 GitHub 變數的時候。
    elements.doneSiteUrlHint.textContent = siteUrl || '你的網址';
  }
  if (elements.doneUrl) {
    elements.doneUrl.textContent = siteUrl || '（還沒填網站網址）';
  }
  if (elements.doneUrlLink) {
    if (siteUrl) {
      elements.doneUrlLink.href = siteUrl;
      elements.doneUrlLink.hidden = false;
    } else {
      elements.doneUrlLink.hidden = true;
    }
  }
  // 「打開我的網站」這類按鈕跟著更新
  document.querySelectorAll('[data-site-link]').forEach(link => {
    if (siteUrl) {
      link.href = siteUrl;
      link.removeAttribute('aria-disabled');
      link.classList.remove('is-disabled');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.classList.add('is-disabled');
    }
  });

  // 金鑰欄位的即時安全提示：一貼上 sb_secret_ 就立刻看到警告，
  // 不用等到按「驗證」才被擋。這是最重要的一道防線，因為貼錯的人不會知道自己貼錯了。
  const keyWarning = document.getElementById('keyWarning');
  if (keyWarning) {
    const kind = classifySupabaseKey(state.publishableKey);
    if (kind.kind === 'secret') {
      keyWarning.hidden = false;
      keyWarning.textContent = `${kind.message} 請立刻把它刪掉，改用 sb_publishable_ 開頭的那把。`;
    } else if (kind.kind === 'unknown' && String(state.publishableKey || '').trim()) {
      keyWarning.hidden = false;
      keyWarning.textContent = '這串文字看起來不像 Supabase 的金鑰（正常會以 sb_publishable_ 開頭）。'
        + '請確認你複製的是 Settings → API Keys 裡的那一串。';
    } else {
      keyWarning.hidden = true;
      keyWarning.textContent = '';
    }
  }
}

// -----------------------------------------------------------------------------
// 複製按鈕
// -----------------------------------------------------------------------------

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return { ok: false, mode: 'empty' };

  // 1. 標準做法。file:// 開啟時 navigator.clipboard 常常不存在或直接被拒。
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return { ok: true, mode: 'clipboard' };
    }
  } catch {
    // 掉下去用備援
  }

  // 2. 備援：塞進看不見的 textarea，用 execCommand('copy')。
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    const selection = window.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(area);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    if (ok) return { ok: true, mode: 'execCommand' };
  } catch {
    // 掉到最後一招
  }

  return { ok: false, mode: 'manual' };
}

function bindCopyButtons(elements, doc) {
  doc.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    event.preventDefault();

    const text = resolveCopyText(button);
    if (!text) {
      flashCopyButton(button, '沒有東西可複製', 'warn');
      return;
    }

    if (button.dataset.copying === '1') return;
    button.dataset.copying = '1';

    const result = await copyText(text);
    delete button.dataset.copying;

    if (result.ok) {
      flashCopyButton(button, '✔ 已複製', 'ok');
      return;
    }
    if (result.mode === 'manual') {
      // 最後一招：把文字選起來，叫使用者自己按複製。
      selectTextOf(button);
      flashCopyButton(button, '請按 ⌘C / Ctrl+C 複製', 'warn');
      return;
    }
    flashCopyButton(button, '複製失敗，請手動選取', 'warn');
  });
}

function resolveCopyText(button) {
  const kind = button.dataset.copy;

  if (kind === 'field') {
    const field = document.querySelector(`[data-field="${button.dataset.copyField}"]`);
    return field ? field.value.trim() : '';
  }
  if (kind === 'element') {
    const node = document.querySelector(button.dataset.copyTarget);
    if (!node) return '';
    return node.dataset.raw || node.textContent || '';
  }
  if (kind === 'value') {
    return button.dataset.copyValue || '';
  }
  if (kind === 'deploy-url') {
    return resolveDeployUrl();
  }
  return '';
}

function resolveDeployUrl() {
  try {
    return buildDeployUrl({
      repoUrl: TEMPLATE.repoUrl,
      projectName: TEMPLATE.defaultProjectName,
      integrationId: TEMPLATE.supabaseIntegrationId
    });
  } catch {
    return '';
  }
}

function flashCopyButton(button, text, tone) {
  if (!button.dataset.originalLabel) {
    button.dataset.originalLabel = button.textContent.trim();
  }
  const original = button.dataset.originalLabel;
  const originalTone = button.dataset.tone || '';
  button.textContent = text;
  button.dataset.tone = tone;
  button.classList.add('is-flashing');

  if (button._flashTimer) clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => {
    button.textContent = original;
    button.dataset.tone = originalTone;
    button.classList.remove('is-flashing');
    button._flashTimer = null;
  }, 2000);
}

function selectTextOf(button) {
  const kind = button.dataset.copy;
  let node = null;
  if (kind === 'element') node = document.querySelector(button.dataset.copyTarget);
  if (!node) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // 選不起來就算了
  }
}

// -----------------------------------------------------------------------------
// 驗證按鈕
// -----------------------------------------------------------------------------

function bindVerifyButtons(elements, state) {
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-verify]');
    if (!button || button.disabled) return;
    event.preventDefault();

    const stepId = resolveStepId(button.dataset.verify);
    if (!stepId) return;

    // 從 DOM 即時讀取欄位，避免使用者貼上後還沒觸發 input 事件就按驗證。
    //
    // 注意這一份叫 fields 不叫 state：state 是整個頁面共用的那一份，
    // 這裡若同名會把它遮蔽掉，後面的 state.verifications[stepId] 就會
    // 寫到這個只有欄位值的暫時物件上而爆掉。
    const fields = readFieldsIntoState();
    setBusy(button, true);
    setResultPending(elements, stepId);

    let outcome;
    try {
      outcome = await runVerification(stepId, fields);
    } catch (error) {
      outcome = {
        state: 'unknown',
        message: `驗證時發生意外狀況：${error && error.message ? error.message : '未知錯誤'}。請再按一次「驗證」。`
      };
    } finally {
      setBusy(button, false);
    }

    // 記到狀態裡
    // 寫回「共用的那一份 state」，而不是另外載入一份新的。
    //
    // 為什麼這很重要：main() 裡的 state 是整個頁面共用的那一份，
    // showStep() 換步驟時會拿它來算進度和打勾。如果這裡用 loadState()
    // 另外開一份新物件，寫進去的驗證結果只存在於區域變數與 localStorage，
    // 共用的 state 仍然不知道——於是使用者「切到下一步」時，
    // updateProgress(state) 會算出 0 步，所有打勾一起消失。
    // 實際症狀：每一步都驗證通過了，但進度條永遠停在「已完成 0 / 5 步」。
    state.verifications[stepId] = { state: outcome.state, message: outcome.message, at: Date.now() };
    for (const field of PERSISTED_FIELDS) {
      if (typeof state[field] === 'string') state[field] = state[field];
    }
    saveState(state);

    renderResult(elements, stepId, outcome.state, outcome.message);
    updateNavChecks(elements, state);
    updateProgress(elements, state);

    // 剛剛驗證通過的話，把面板上的「建議先完成上一步」提醒收起來
    if (outcome.state === 'pass') {
      const activePanel = elements.panels.find(panel => panel.dataset.panel === state.currentStep);
      if (activePanel) {
        const banner = activePanel.querySelector('[data-prerequisite]');
        if (banner) banner.hidden = true;
      }
    }
  });
}

function readFieldsIntoState() {
  const collected = {};
  document.querySelectorAll('[data-field]').forEach(field => {
    const name = field.dataset.field;
    if (PERSISTED_FIELDS.includes(name)) collected[name] = field.value;
  });
  return collected;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
  button.textContent = busy ? '驗證中…' : button.dataset.idleLabel;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function setResultPending(elements, stepId) {
  const box = document.querySelector(`[data-result="${stepId}"]`);
  if (!box) return;
  box.hidden = false;
  box.dataset.state = 'pending';
  box.innerHTML = '<span class="result-icon" aria-hidden="true">…</span><span class="result-text">正在驗證，請稍等（最多 12 秒）。</span>';
}

function renderResult(elements, stepId, state, message) {
  const box = document.querySelector(`[data-result="${stepId}"]`);
  if (!box) return;
  const icon = state === 'pass' ? '✔' : state === 'fail' ? '✖' : '⚠';
  const label = state === 'pass' ? '通過' : state === 'fail' ? '不通過' : '看不出來';
  box.hidden = false;
  box.dataset.state = state;
  box.innerHTML = `<span class="result-icon" aria-hidden="true">${icon}</span>`
    + `<span class="result-text"><strong>${label}：</strong>${escapeHtml(message)}</span>`;
}

function clearResult(elements, stepId) {
  const box = document.querySelector(`[data-result="${stepId}"]`);
  if (!box) return;
  box.hidden = true;
  box.dataset.state = '';
  box.textContent = '';
}

// -----------------------------------------------------------------------------
// 真正發網路請求的地方
// -----------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = WIZARD.requestTimeoutMs || 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, mode: 'cors', credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}

async function runVerification(stepId, state) {
  switch (stepId) {
    case 'start':
      return { state: 'pass', message: '這一步只是說明，不需要驗證。' };
    case 'github':
      return verifyGithub(state);
    case 'deploy':
      return verifyDeploy(state);
    case 'database':
      return verifyDatabase(state);
    case 'schema':
      return verifySchema(state);
    case 'admin':
      return verifyAdmin(state);
    case 'done':
      return { state: 'pass', message: '全部做完了，不需要驗證。' };
    default:
      return { state: 'unknown', message: '這個步驟沒有驗證方式。' };
  }
}

async function verifyGithub(state) {
  const username = String(state.githubUsername || '').trim().replace(/^@+/, '');

  if (!username) {
    return { state: 'fail', message: '請先在上面輸入你的 GitHub 使用者名稱。' };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(username)) {
    return {
      state: 'fail',
      message: '使用者名稱只能有英文、數字和減號（-），而且不能有空白或中文。'
        + '請輸入 GitHub 網站右上角大頭貼旁邊顯示的那個名字。'
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers: { accept: 'application/vnd.github+json' }
    });
  } catch (error) {
    const info = classifyFetchError(error);
    if (info.kind === 'timeout') {
      return { state: 'unknown', message: `連不到 GitHub：${info.message}請確認電腦的網路正常後再試一次。` };
    }
    return {
      state: 'unknown',
      message: '連不到 GitHub（可能是網路不通，或瀏覽器擋住了這個查詢）。'
        + '你可以直接打開 https://github.com/ 登入看看，如果進得去就代表帳號沒問題。'
    };
  }

  if (response.status === 200) {
    return { state: 'pass', message: '找到這個 GitHub 帳號了，這一步完成。' };
  }
  if (response.status === 404) {
    return {
      state: 'fail',
      message: 'GitHub 找不到這個使用者名稱。請確認：(1) 拼字一模一樣、(2) 帳號註冊已經完成（要點過驗證信）、'
        + '(3) 你輸入的是「使用者名稱」不是 email。'
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      state: 'unknown',
      message: 'GitHub 說「查詢次數超過今天的免費額度」，所以現在查不到。這不是你的問題，'
        + '請等大約 1 小時再按一次「驗證」；你也可以直接打開 https://github.com/ 看自己的首頁有沒出現。'
    };
  }
  return {
    state: 'unknown',
    message: `GitHub 回了 HTTP ${response.status}，我不確定這是什麼狀況。請稍後再試一次。`
  };
}

async function verifyDeploy(state) {
  const siteUrl = normalizeSiteUrl(state.siteUrl);

  if (!siteUrl) {
    return {
      state: 'fail',
      message: '這個網址看起來不完整。Vercel 給你的網址通常長得像 https://專案名稱.vercel.app，'
        + '請整段複製過來（前面要有 https://）。'
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(`${siteUrl}/api/health`, {
      headers: { accept: 'application/json' }
    });
  } catch (error) {
    // 這裡最常見的原因就是跨網域限制（尤其從 file:// 開啟這個引導頁時）。
    // 依規定：不要說使用者做錯了。
    const info = classifyFetchError(error);
    return {
      state: 'unknown',
      message: '我這邊看不到（跨網域限制，瀏覽器不讓我讀別的網站的內容）——這不代表你做錯。'
        + (info.kind === 'timeout' ? '（剛剛等超過 12 秒。）' : '')
        + '如果你自己在瀏覽器打開那個網址看得到研究室系統，就是成功了，直接按「下一步」。'
    };
  }

  const body = await readResponseBody(response);

  if (response.ok) {
    const service = body && typeof body === 'object' ? String(body.service || body.app || '') : '';
    const accepted = WIZARD.acceptedServiceNames || [];
    const matches = accepted.some(name => service.toLowerCase() === String(name).toLowerCase());
    if (matches) {
      return { state: 'pass', message: `連上了，回應的系統名稱是「${service}」，就是這套研究室系統。這一步完成。` };
    }
    if (service) {
      return {
        state: 'unknown',
        message: `網址打得開，但回應的系統名稱是「${service}」，跟我預期的不一樣。`
          + '如果你確定這就是你的研究室系統（打開看得到登入畫面），那就是部署成功，可以按「下一步」。'
      };
    }
    return {
      state: 'unknown',
      message: '網址打得開，但回應裡沒有系統名稱。可能是部署還在進行中（第一次部署要 1～3 分鐘）。'
        + '請直接打開那個網址看看，有看到研究室系統就是成功了。'
    };
  }

  if (response.status === 404) {
    return {
      state: 'unknown',
      message: '網站有回應，但找不到健康檢查的網址（HTTP 404）。通常是：(1) 部署還沒完成，'
        + '(2) 你貼的是 Vercel 後台網址而不是網站網址。請直接打開那個網址看看。'
    };
  }

  return {
    state: 'unknown',
    message: `網站回了 HTTP ${response.status}。請直接打開那個網址看看能不能用；`
      + '如果看得到研究室系統，就不用管我這邊的檢查結果。'
  };
}

async function verifyDatabase(state) {
  const supabaseUrl = normalizeSupabaseUrl(state.supabaseUrl);
  const key = String(state.publishableKey || '').trim();

  if (!supabaseUrl) {
    return {
      state: 'fail',
      message: 'Supabase 專案網址看起來不對。它應該長得像 https://abcdefgh.supabase.co'
        + '（在 Supabase 後台 Settings → API 找到）。'
    };
  }
  if (!key) {
    return {
      state: 'unknown',
      message: '資料庫網址有了，但還沒貼金鑰（key）。請到 Supabase 後台 Settings → API Keys，'
        + '複製 sb_publishable_ 開頭的那一串貼上來。'
    };
  }

  // 安全檢查：貼成 secret key 就立刻擋下來，一個請求都不送。
  const keyKind = classifySupabaseKey(key);
  if (keyKind.kind === 'secret') {
    return {
      state: 'fail',
      message: `${keyKind.message}（這一步我先幫你停住，沒有把任何東西送出去。）`
        + ' 正確的金鑰在 Supabase 後台 Settings → API Keys，選 sb_publishable_ 開頭那個。'
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/health`, {
      headers: { apikey: key, accept: 'application/json' }
    });
  } catch (error) {
    const info = classifyFetchError(error);
    return {
      state: 'unknown',
      message: `連不到這個資料庫（${info.kind === 'timeout' ? info.message : '可能是網路不通或跨網域限制'}）。`
        + '請確認網路正常，以及 Supabase 專案是不是還在建立中（新建專案要等 1～2 分鐘），稍後再試。'
    };
  }

  if (response.status === 200) {
    return { state: 'pass', message: '連上你的 Supabase 資料庫了，這一步完成。' };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      state: 'fail',
      message: 'Supabase 說這把金鑰（key）不對。請回 Supabase 後台 Settings → API Keys，'
        + '重新複製 sb_publishable_ 開頭的那一串，整段貼上，不要多空格。'
    };
  }
  if (response.status === 404) {
    return {
      state: 'fail',
      message: '這個網址打得開，但找不到 Supabase 的健康檢查端點（HTTP 404）。'
        + '請確認貼的是「專案網址」（https://xxxx.supabase.co），不是 Supabase 官方網站或後台網址。'
    };
  }
  return {
    state: 'unknown',
    message: `資料庫回了 HTTP ${response.status}，我不確定這是什麼狀況。請稍後再按一次「驗證」。`
  };
}

// 問資料庫「這個欄位在不在」。
//
// PostgREST 對不存在的欄位會回 400 加 code 42703（undefined_column）。
// 其他任何狀況（連不上、權限、404）都回 exists:null =「不確定」，
// 由呼叫端決定要不要判斷失敗 —— 不確定的時候不可以說使用者做錯。
async function probeColumnExists(supabaseUrl, key, table, column) {
  try {
    const response = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(column)}&limit=1`,
      { headers: { apikey: key, accept: 'application/json' } }
    );
    if (response.ok) return { exists: true };
    const body = await readResponseBody(response);
    return { exists: interpretColumnProbe(body, column) };
  } catch {
    return { exists: null };
  }
}

// 從 PostgREST 的錯誤內容判斷「欄位不存在」還是「其他問題」。
// 只有明確的 42703 / "column ... does not exist" 才算不存在。
// 匯出給單元測試用：這段判斷錯了會讓「漏跑第 3 段」完全看不出來。
export function interpretColumnProbe(body, column) {
  let parsed = null;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.code === '42703') return false;
    const message = String(parsed.message || '');
    // PostgREST 的訊息會把欄位名加上雙引號，例如
    //   column "auto_update_enabled" does not exist
    // 所以引號（單、雙、反引號）都要當作可能出現的字元，否則這條判斷
    // 永遠不會成立，變成「只認 code，不認文字」。
    const quoted = `[\"'\`]?`;
    if (new RegExp(`column\\s+${quoted}[\\w.]*${column}[\\w.]*${quoted}\\s+does not exist`, 'i').test(message)) return false;
  }
  return null;
}

async function verifySchema(state) {
  const supabaseUrl = normalizeSupabaseUrl(state.supabaseUrl);
  const key = String(state.publishableKey || '').trim();
  const tables = Array.isArray(WIZARD.schemaProbeTables) && WIZARD.schemaProbeTables.length
    ? WIZARD.schemaProbeTables
    : [WIZARD.schemaProbeTable || 'lab_state'];

  if (!supabaseUrl) {
    return { state: 'fail', message: '還缺 Supabase 的專案網址。請先回上一步「建立資料庫」貼上並驗證。' };
  }
  if (!key) {
    return { state: 'fail', message: '還缺 Supabase 的金鑰（key）。請先回上一步「建立資料庫」貼上並驗證。' };
  }

  // 安全檢查：絕不把 secret key 送出去。
  const keyKind = classifySupabaseKey(key);
  if (keyKind.kind === 'secret') {
    return {
      state: 'fail',
      message: `${keyKind.message} 請回上一步「建立資料庫」，換成 sb_publishable_ 開頭那把。`
    };
  }

  // 每一張表都問一次。任何一張連線失敗就當「看不懂」，不要亂判失敗。
  const verdicts = [];
  for (const table of tables) {
    let status = 0;
    let body = '';
    try {
      const response = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=id&limit=1`,
        { headers: { apikey: key, accept: 'application/json' } }
      );
      status = response.status;
      body = await readResponseBody(response);
    } catch (error) {
      const info = classifyFetchError(error);
      return {
        state: 'unknown',
        message: `連不到你的資料庫（${info.kind === 'timeout' ? info.message : '可能是網路不通。'}）`
          + '請確認網路正常後再按一次「驗證」。'
      };
    }
    verdicts.push({ table, verdict: interpretSchemaProbe({ status, body, tableName: table }) });
  }

  // 表都在了，還要確認「只在既有表上加欄位」的那一段有沒有跑。
  // 第 3 段（003）就是這種：它不新增表，所以上面的表探測永遠說沒問題。
  // 漏跑的話系統看起來完全正常，只有自動更新開關按不動 —— 在驗證這一步
  // 就講清楚，比讓他自己按到壞掉再回報好得多。
  const columnProbes = Array.isArray(WIZARD.schemaProbeColumns) ? WIZARD.schemaProbeColumns : [];
  for (const probe of columnProbes) {
    if (!probe || !probe.table || !probe.column) continue;
    const check = await probeColumnExists(supabaseUrl, key, probe.table, probe.column);
    if (check.exists === false) {
      return {
        state: 'fail',
        message: `資料表都在，但還缺${probe.label || '一段語法'}：`
          + `「${probe.table}」少了「${probe.column}」這個欄位。`
          + '系統可以使用，只有「系統設定」裡的自動更新開關會按不動。'
          + '請把上面屬於該段的那段語法貼進 Supabase 的 SQL Editor，按一次 RUN。'
      };
    }
  }

  const missing = verdicts.filter(item => !item.verdict.schemaInstalled);
  if (missing.length === 0) {
    return {
      state: 'pass',
      message: `資料表都建好了（${verdicts.map(item => `「${item.table}」`).join('、')}）。`
        + '回應是空的 [] 也沒關係：資料表存在，但沒登入的人依權限規則讀不到任何一列。'
    };
  }

  // 只缺後面的段數 → 講清楚是哪一段沒跑。
  const missingNames = missing.map(item => item.table);
  const firstMissing = missing[0];
  // 常見的半完成狀態：第 1 段跑了、第 2 段沒跑。這種情況講「還缺第 2 段」最有用，
  // 所以就用這個訊息，不要再加上一段重複的「資料表還沒建立」。
  const onlySecondSegmentMissing = missingNames.length === 1
    && missingNames[0] === 'lab_settings'
    && verdicts.some(item => item.table === 'lab_state' && item.verdict.schemaInstalled);

  if (onlySecondSegmentMissing) {
    return {
      state: 'fail',
      message: '第 1 段（001）看起來跑過了，但還缺第 2 段（002）。'
        + '請把上面「第 2 段」那段語法也貼進 Supabase 的 SQL Editor，按一次 RUN。'
    };
  }
  return {
    state: 'fail',
    message: firstMissing.verdict.reason
  };
}

async function verifyAdmin(state) {
  const siteUrl = normalizeSiteUrl(state.siteUrl);

  if (!siteUrl) {
    return { state: 'fail', message: '還缺網站網址。請先回第 3 步貼上 Vercel 給你的網址。' };
  }

  let response;
  try {
    response = await fetchWithTimeout(`${siteUrl}/api/setup-status`, {
      headers: { accept: 'application/json' }
    });
  } catch (error) {
    const info = classifyFetchError(error);
    return {
      state: 'unknown',
      message: '我這邊看不到（跨網域限制），無法確認設定完成沒。'
        + (info.kind === 'timeout' ? '（剛剛等超過 12 秒。）' : '')
        + '請直接打開你的網站：如果看到的是正常的登入畫面、不再是「第一次使用」的表格，就是成功了。'
    };
  }

  const body = await readResponseBody(response);

  if (response.status === 404) {
    return {
      state: 'unknown',
      message: '網站有回應，但找不到 /api/setup-status（HTTP 404）。可能是這個版本的程式還沒有這個功能。'
        + '請直接打開你的網站看看：看到登入畫面而不是「第一次使用」的表格，就代表成功了。'
    };
  }
  if (!response.ok) {
    return {
      state: 'unknown',
      message: `網站回了 HTTP ${response.status}。請直接打開你的網站看看能不能登入；`
        + '能登入就代表設定完成，不用管我這邊的檢查結果。'
    };
  }

  const summary = interpretSetupStatus(body);
  if (summary.allDone) {
    return { state: 'pass', message: '設定完成了。你的研究室系統已經可以開始用。' };
  }

  // 伺服器對每一項都有具體說明（例如「還缺第二段設定語法」），
  // 那些字比我們自己掰的還準，所以直接附上。
  //
  // 但要先拿掉「請先完成第 N 步」「回到引導網頁第 N 步」這種句子：
  // api/setup-status.js 是照規格書的 0～6 編號寫的，這個引導頁畫面上顯示的
  // 卻是「第 1 步～第 7 步」，兩邊差一號。留著會讓助理跳到錯的步驟去。
  // 這種「該去哪一步」的指引，由下面我們自己依 pending 的 id 補上。
  //
  // 這裡刻意用「整句刪掉」而不是「把數字改掉」：我們無從得知伺服器那句話
  // 指的是哪一號（它可能是舊版、可能改過措辭），改數字反而更危險。
  const stripStepReferences = text => String(text)
    .split(/(?<=[。！？；])/)
    .filter(sentence => !/第\s*\d+\s*步/.test(sentence))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const pending = summary.steps.filter(step => !step.ok);
  const pendingLabels = pending.map(step => step.label);
  const details = pending
    .map(step => stripStepReferences(step.detail))
    .filter(text => text && text !== '已完成。' && !/還沒完成。$/.test(text));

  const parts = [];
  if (pendingLabels.length) parts.push(`還沒完成的是：${pendingLabels.join('、')}。`);
  if (details.length) parts.push(details.join(' '));

  // 「下一步該做什麼」要看真正卡住的是哪一關，不要一律叫他去填表單。
  // 例如資料表還沒建好時，他填一百次表單也不會成功。
  //
  // 順序有意義：先看資料表（最常見的半完成狀態），再看環境設定與連線。
  // 'database' 與 'environment' 的修法完全不同，不能混為一談：
  //   environment = Vercel 沒把金鑰填好  → 回 Vercel 補設定
  //   database    = 連不上，多半是閒置被暫停 → 去 Supabase 按 Restore
  // 把後者講成前者，會讓人白花時間重設一次金鑰，資料庫還是醒不過來。
  const pendingIds = new Set(pending.map(step => step.id));
  const alreadyMentionsForm = details.some(text => /第一次使用|表單|建立管理員/.test(text));

  if (pendingIds.has('schema')) {
    parts.push('這要回到第 5 步「建立資料表」，把建表語法（記得每一段都要）貼進 Supabase 的 SQL Editor 執行。');
  } else if (pendingIds.has('environment')) {
    parts.push('請回到第 4 步「建立資料庫」，確認 Vercel 上有把 Supabase 的金鑰填好（照 Vercel 的畫面點就會自動填）。');
  } else if (pendingIds.has('database')) {
    // 伺服器自己的說明通常已經講了「按 Restore 喚醒」，那就不要再重複一次。
    if (!details.some(text => /Restore|暫停/i.test(text))) {
      parts.push('請到 Supabase 後台看看專案是不是被暫停了：免費方案閒置 7 天會自動暫停，'
        + '按畫面上的 Restore 就會醒來，資料不會不見。醒來後再按一次「驗證」。');
    }
  } else if (!alreadyMentionsForm) {
    parts.push('請打開你的網站，把「第一次使用」的表單填完'
      + '（研究室名稱、你的名字、email、至少 8 個字元的密碼）。');
  }

  return {
    state: 'fail',
    // 注意：這些訊息一律當「純文字」呈現（renderResult 會跳脫 HTML），
    // 所以這裡不可以放 <strong> 之類的標籤，否則使用者會看到標籤本身。
    message: parts.join(' ')
  };
}

// -----------------------------------------------------------------------------
// 建表語法：從 index.html 內嵌的 <script type="text/plain"> 取出來
//
// 每一個 migration 檔一段，寫成
//   <script type="text/plain" class="migration-sql" data-sql-segment
//           data-label="第 1 段" data-filename="001_lab_state.sql">…SQL…</script>
//
// 為什麼 data-sql-segment 掛在 script 標籤上，而不是在裡面再包 <section>：
// <script> 的內容是「純文字」，瀏覽器不會把裡面的標籤解析成 DOM。
// 以前那種寫法會讓 SQL 區塊整個消失（被當成文字印在標籤裡），所以改成現在這樣。
// 下面同時保留舊寫法的查詢當備援，免得有人照舊格式加段落時整個壞掉。
// -----------------------------------------------------------------------------

function readSqlSegments() {
  let nodes = Array.from(document.querySelectorAll('script.migration-sql[data-sql-segment]'));

  // 備援：舊格式（段落包在 #migrationSql 裡面）。正常情況下這條路不會有東西。
  if (nodes.length === 0) {
    const nested = document.getElementById('migrationSql');
    if (nested) nodes = Array.from(nested.querySelectorAll('[data-sql-segment]'));
  }

  return nodes.map((node, index) => ({
    index,
    label: node.dataset.label || `第 ${index + 1} 段`,
    filename: node.dataset.filename || '',
    sql: (node.textContent || '').replace(/^\n+/, '').replace(/\s+$/, '')
  })).filter(segment => segment.sql);
}

function renderMigrationSql(elements) {
  const container = document.getElementById('sqlSegments');
  if (!container) return;

  const segments = readSqlSegments();
  if (segments.length === 0) {
    container.textContent = '（找不到建表語法。這份引導頁可能被複製壞了，請重新跟資訊人員索取。）';
    return;
  }

  container.innerHTML = '';
  segments.forEach(segment => {
    const wrap = document.createElement('details');
    wrap.className = 'sql-block';
    if (segments.length === 1) wrap.open = false;

    const summary = document.createElement('summary');
    summary.className = 'sql-summary';
    summary.innerHTML = `<span class="sql-label">${escapeHtml(segment.label)}</span>`
      + `<span class="sql-meta">${escapeHtml(segment.filename)} · ${segment.sql.split('\n').length} 行</span>`
      + '<span class="sql-toggle" aria-hidden="true"></span>';
    wrap.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'sql-body';

    const toolbar = document.createElement('div');
    toolbar.className = 'sql-toolbar';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn btn-copy';
    copyButton.dataset.copy = 'value';
    copyButton.dataset.copyValue = segment.sql;
    copyButton.textContent = '複製這段語法';
    toolbar.appendChild(copyButton);

    const note = document.createElement('span');
    note.className = 'sql-note';
    note.textContent = '整段複製，貼到 Supabase 的 SQL Editor，按 RUN。';
    toolbar.appendChild(note);

    body.appendChild(toolbar);

    const pre = document.createElement('pre');
    pre.className = 'sql-code';
    pre.tabIndex = 0;
    pre.textContent = segment.sql;
    body.appendChild(pre);

    wrap.appendChild(body);
    container.appendChild(wrap);
  });

  // 「複製全部」按鈕（多段時才有意義）
  const copyAll = document.getElementById('copyAllSql');
  if (copyAll) {
    if (segments.length > 1) {
      copyAll.hidden = false;
      copyAll.dataset.copy = 'value';
      copyAll.dataset.copyValue = segments.map(segment => segment.sql).join('\n\n');
    } else {
      copyAll.hidden = true;
    }
  }

  const meta = document.getElementById('sqlSegmentCount');
  if (meta) {
    meta.textContent = segments.length === 1
      ? '這份建表語法只有 1 段，全部貼進去就好。'
      : `這份建表語法分成 ${segments.length} 段，請「照順序」一段一段貼進 SQL Editor，每段都要按一次 RUN。`;
  }
}

// -----------------------------------------------------------------------------
// 部署區塊
// -----------------------------------------------------------------------------

function renderDeploySection(elements) {
  const url = resolveDeployUrl();
  if (elements.deployLink) {
    if (url) {
      elements.deployLink.href = url;
      elements.deployLink.classList.add('is-ready');
    } else {
      elements.deployLink.setAttribute('aria-disabled', 'true');
    }
  }
  if (elements.deployUrlText) {
    elements.deployUrlText.textContent = url || '（設定有問題，產不出網址）';
  }

  const paramList = document.getElementById('deployParamList');
  if (paramList && url) {
    const rows = [
      ['repository-url', TEMPLATE.repoUrl, '要複製的程式碼來源。你的 GitHub 會多一份自己的副本。'],
      ['project-name', TEMPLATE.defaultProjectName, 'Vercel 上這個專案的名字，也是網址的一部分。'],
      ['repository-name', TEMPLATE.defaultProjectName, '複製到你 GitHub 後，那個 repo 要叫什麼名字。'],
      ['integration-ids', TEMPLATE.supabaseIntegrationId, 'Supabase 官方整合的編號。帶了這個，部署流程才會問你要不要建資料庫（第 4 步）。'],
      ['external-id', TEMPLATE.repoUrl, '只是讓 Vercel 後台知道「這個部署從哪來的」，不影響功能。']
    ];
    paramList.innerHTML = rows.map(([name, value, explain]) => (
      `<li><code>${escapeHtml(name)}</code><span class="param-value">${escapeHtml(value)}</span>`
      + `<span class="param-explain">${escapeHtml(explain)}</span></li>`
    )).join('');
  }
}

// -----------------------------------------------------------------------------
// 重設
// -----------------------------------------------------------------------------

function bindResetButton(elements, state) {
  if (!elements.resetButton) return;
  elements.resetButton.addEventListener('click', () => {
    const ok = window.confirm('這會清掉你在這台電腦上填過的所有內容（GitHub 帳號、網址、金鑰），確定要清嗎？');
    if (!ok) return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 清不掉就算了
    }
    window.location.reload();
  });
}

// -----------------------------------------------------------------------------
// 小工具
// -----------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 讓 Node 匯入時不會爆：瀏覽器才有 document。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
}
