// Supabase 連線層：同時支援新舊兩套 API 金鑰名稱。
//
// Supabase 正在汰換 anon / service_role（JWT 格式）金鑰，改用
// publishable（sb_publishable_…）與 secret（sb_secret_…）金鑰。
// 官方時程是 2026 年底停用舊金鑰，但兩套金鑰現在同時有效。
//
// 為什麼要在這裡做相容層而不是叫使用者改名：
//   Vercel Marketplace 的 Supabase 整合注入的是新名稱
//   （SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY），
//   而從舊版手動部署的研究室設定的是舊名稱
//   （SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）。
//   兩種人都要能跑，所以兩種名稱都讀。
//
// 為什麼金鑰只放 apikey 標頭、不放 Authorization：
//   新的 publishable / secret 金鑰不是 JWT，放進 Authorization: Bearer
//   會被平台當成 JWT 解析並回 401 Invalid JWT。官方文件明確要求新金鑰
//   「只放 apikey」。使用者自己的 JWT 才放 Authorization。

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// 引導網頁（wizard）跑在別的網域上（可能是 file://，也可能是維護者的網站），
// 它要打 /api/health 和 /api/setup-status 才能告訴助理「你的部署成功了」。
// 沒有 CORS 標頭的話，瀏覽器會擋住回應，那兩個檢查永遠是「看不出來」，
// 等於整個引導流程最重要的兩步失效。
//
// 只有這兩個端點需要跨網域，而且它們都刻意只回報「設定了沒」，
// 不含金鑰也不含個人資料 —— 所以這裡用 '*' 是安全的。
// 需要身分的端點（data、profiles、backups…）不加 CORS：
// 那些用 Authorization 標頭帶 JWT，本來就不該讓任意網頁代打。
// update-policy 也在裡面：GitHub Actions 從 github.com 的 runner 打過來問
// 「這間研究室關掉自動更新了嗎」。那條請求不會帶任何使用者 token，所以
// 只開放它自己的 GET（它只回一個布林值與網站網址，沒有成員資料或金鑰）。
const CORS_OPEN_PATHS = new Set(['health', 'setup-status', 'config', 'update-policy']);

function isCorsOpenPath(req) {
  const url = String(req.url || '');
  const match = url.match(/\/api\/([a-z0-9-]+)/i);
  return match ? CORS_OPEN_PATHS.has(match[1].toLowerCase()) : false;
}

export function applyCors(req, res) {
  if (!isCorsOpenPath(req)) return false;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'accept, content-type');
  res.setHeader('access-control-max-age', '86400');
  // 預檢請求：回 204 就結束，不要繼續跑進 handler。
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function sendJson(res, status, body) {
  res.status(status).setHeader('content-type', JSON_HEADERS['content-type']);
  return res.end(JSON.stringify(body));
}

export function methodAllowed(res, methods) {
  res.setHeader('allow', methods.join(', '));
  sendJson(res, 405, { error: 'method_not_allowed', allowed: methods });
}

export function getBearerToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function requireUserToken(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'unauthorized', message: '需要登入後的 Bearer token。' });
    return null;
  }
  return token;
}

// 讀環境變數，多個名稱依序找第一個有值的。
function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

// 新的 secret 金鑰有兩種可能格式：單一字串，或 {"default":"sb_secret_…"} 這種 JSON。
// 後者出現在 Edge Functions 的環境變數裡，一般 Vercel 專案不會有，
// 但讀到時不該直接爆掉。
export function normalizeKey(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.default === 'string') return parsed.default.trim();
      const firstString = Object.values(parsed).find(value => typeof value === 'string' && value.trim());
      if (firstString) return firstString.trim();
    }
  } catch { /* 不是 JSON 就當一般字串 */ }
  return text;
}

// 回傳這個金鑰是不是走新制。判斷依據是字首，不是長度。
export function isNewStyleKey(key) {
  return /^sb_(publishable|secret)_/.test(String(key || '').trim());
}

export function supabaseConfig(serverOnly = false) {
  const url = firstEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const key = normalizeKey(serverOnly
    ? firstEnv('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
    : firstEnv('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'));
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key, serverOnly, newStyleKey: isNewStyleKey(key) };
}

// 組出送往 Supabase 的標頭。
//
// 這裡有一個實測出來的關鍵差異，寫錯會讓資料「看起來是空的」：
//   新制金鑰（sb_publishable_/sb_secret_）不是 JWT，只能放 apikey。
//     若同時放 Authorization: Bearer，平台會把它當 JWT 解析而回 401。
//   舊制金鑰（eyJ 開頭的 anon/service_role）本身就是 JWT，角色資訊在
//     token 裡。只放 apikey 時 PostgREST 會把它當匿名請求 → RLS 全部擋掉，
//     回應是 HTTP 200 但內容是 []（不會報錯，非常容易誤判成「沒有資料」）。
//     實測：service_role 只放 apikey 讀 lab_profiles 得到 []，
//     加上 Authorization: Bearer 才拿到真正的資料列。
//
// 所以：有登入者的 token 就用登入者；否則看金鑰是新制還是舊制決定。
function buildHeaders(config, userToken, extra = {}) {
  const headers = {
    apikey: config.key,
    'content-type': 'application/json'
  };
  if (userToken) {
    headers.authorization = `Bearer ${userToken}`;
  } else if (!config.newStyleKey) {
    // 舊制金鑰必須同時放進 Authorization，角色才會生效
    headers.authorization = `Bearer ${config.key}`;
  }
  return { ...headers, ...extra };
}

// 給不經過 supabaseFetch 的地方用（例如需要自訂 timeout 的探測）
export function supabaseHeaders(config, userToken = '', extra = {}) {
  return buildHeaders(config, userToken, extra);
}

function requireConfig(serverOnly) {
  const config = supabaseConfig(serverOnly);
  if (!config) throw new Error('supabase_not_configured');
  return config;
}

// 以登入使用者身分呼叫（沒帶 token 就是匿名身分，受 RLS 限制）。
export async function supabaseFetch(path, options = {}, token = '') {
  const config = requireConfig(false);
  return fetch(`${config.url}${path}`, { ...options, headers: buildHeaders(config, token, options.headers) });
}

// 以服務層身分呼叫（繞過 RLS），需要 secret / service_role 金鑰。
export async function supabaseServerFetch(path, options = {}) {
  const config = requireConfig(true);
  return fetch(`${config.url}${path}`, { ...options, headers: buildHeaders(config, '', options.headers) });
}

// 用 Secret 金鑰在伺服器端建立 Auth 使用者。
// 這支刻意獨立出來，因為新舊金鑰在 Auth 管理端點的行為要分別處理。
export async function supabaseAdminFetch(path, options = {}) {
  return supabaseServerFetch(path, options);
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// 給 /api/config 與 /api/setup-status 共用的「這個部署設定了什麼」摘要。
// 只回報「有沒有設定」，不回傳金鑰本身。
export function describeConfig() {
  const anon = supabaseConfig(false);
  const service = supabaseConfig(true);
  return {
    url: anon?.url || '',
    hasPublishableKey: Boolean(anon?.key),
    hasSecretKey: Boolean(service?.key),
    keyStyle: anon?.newStyleKey ? 'new' : (anon?.key ? 'legacy' : 'none'),
    serverKeyStyle: service?.newStyleKey ? 'new' : (service?.key ? 'legacy' : 'none'),
    ready: Boolean(anon?.url && anon?.key)
  };
}

// 建表語法的版本（第 4 段起才有 lab_schema_version()）。
// /api/setup-status 與 /api/update-policy（系統設定頁）都用它提示「還沒補跑第 4 段」。
// 第 4 段只修函式的權限檢查，不加表也不加欄位 —— 不問這個函式，永遠不知道它跑過沒。
// 回傳：true = 已套用；false = 確定沒套用（函式不存在或版本太舊）；
//       連線問題時當作已套用，不要因為一次網路抖動就叫人重跑 SQL。
export const REQUIRED_SCHEMA_VERSION = 4;
export async function probeSchemaVersion(url, keyConfig) {
  try {
    const response = await fetch(`${url}/rest/v1/rpc/lab_schema_version`, {
      method: 'POST',
      headers: buildHeaders(keyConfig),
      body: '{}',
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 404) return false;
    if (!response.ok) return true;
    const body = await response.json().catch(() => null);
    // 只接受真正的數字（Number([]) 是 0，會把看不懂的回應誤判成版本太舊）。
    return typeof body === 'number' ? body >= REQUIRED_SCHEMA_VERSION : true;
  } catch {
    return true;
  }
}
