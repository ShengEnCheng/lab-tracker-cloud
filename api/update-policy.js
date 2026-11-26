// /api/update-policy：研究室「要不要每天自動更新到最新版」的開關。
//
// ---------------------------------------------------------------------------
// 為什麼需要這支端點：介面與 GitHub Actions 之間沒有直接連線
// ---------------------------------------------------------------------------
// 真正執行自動更新的是 GitHub Actions，它跑在研究室自己的 repo 裡，手上只有
// GITHUB_TOKEN —— 沒有任何 Supabase 金鑰，因此讀不到 lab_settings。
//
// 反過來，介面上的開關跑在瀏覽器裡，它改得動資料庫，但沒有任何權限去動
// GitHub 的排程。
//
// 所以兩邊只能靠這支端點搭橋：
//
//   介面開關 → PATCH 這裡 → 寫進 lab_settings.auto_update_enabled
//   Actions  → GET 這裡 → 得到 { autoUpdate: true|false }
//
// 這也是為什麼 GET 必須「不用登入就能讀」：Actions 不會帶使用者 token。
// 它只回一個布林值與網站自己的網址，沒有任何成員資料或金鑰，所以可以公開。
//
// ---------------------------------------------------------------------------
// 讀不到資料庫時的行為（很重要）
// ---------------------------------------------------------------------------
// 回 autoUpdate:true（＝維持原本行為）。
//
// 理由：這個系統預設就是自動更新。資料庫暫時連不上（例如免費 Supabase 專案
// 閒置被暫停）不該被解讀成「這間研究室關掉了自動更新」—— 那會讓一次短暫的
// 故障變成永久停止更新，而且沒人會發現。讀不到就當成沒關，寧可多更新一次。

import {
  applyCors, methodAllowed, readJsonBody, requireUserToken, sendJson,
  supabaseConfig, supabaseFetch, supabaseHeaders, probeSchemaVersion
} from './_supabase.js';
import { APP_VERSION } from '../src/lib/app-info.js';

const ADMIN_ROLES = new Set(['admin', 'backup_admin']);

// 從請求標頭推出「這個網站自己的網址」。
//
// 為什麼要回這個：Actions 需要知道要問哪一個網址。它自己查不到（實測過
// GitHub Deployments API：Vercel 有部署保護時回 302 到 SSO，舊部署則回 410），
// 所以由網站告訴它「我就是這個網址」，讓管理者可以把值填到 GitHub 的變數裡。
export function siteUrlFromRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (/^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// 用 secret 金鑰讀（lab_settings 的 RLS 只給管理員，匿名讀不到資料列）。
async function readPolicy() {
  const config = supabaseConfig(false);
  const secret = supabaseConfig(true);
  if (!config || !secret) return { configured: false, autoUpdate: true, schemaReady: false };

  try {
    const response = await fetch(
      `${config.url}/rest/v1/lab_settings?id=eq.1&select=auto_update_enabled`,
      { headers: supabaseHeaders(secret), signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) {
      // 42703 = 欄位不存在：代表這個研究室還沒跑第 3 段 SQL。
      const body = await response.json().catch(() => ({}));
      const missingColumn = body?.code === '42703' || /auto_update_enabled/.test(JSON.stringify(body));
      return { configured: true, autoUpdate: true, schemaReady: !missingColumn };
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      // 還沒完成第一次設定：視為預設值（開），但標記欄位是存在的。
      return { configured: true, autoUpdate: true, schemaReady: true };
    }
    return { configured: true, autoUpdate: rows[0].auto_update_enabled !== false, schemaReady: true };
  } catch {
    // 資料庫連不上。維持預設行為（開），不要因為一次故障就永久停掉更新。
    return { configured: true, autoUpdate: true, schemaReady: true, unreachable: true };
  }
}

// 查出「發出這個請求的人」是誰、他能不能改設定。
//
// 一定要先用 token 向 Auth 問出使用者 id，再拿那個 id 去查 profile。
// 不能只查 lab_profiles 然後取第一列 —— 那會取到別人的角色：
// lab_profiles 有多列，第一位很可能是管理員，於是任何一個登入的人
// 都會被當成管理員。這種漏洞在畫面上完全看不出來（開關就是能按），
// 只有實際去改資料才會發現。
async function callerRole(token) {
  const authResponse = await supabaseFetch('/auth/v1/user', {}, token);
  const user = await authResponse.json().catch(() => ({}));
  if (!authResponse.ok || !user?.id) return { id: '', role: '', active: false };

  const response = await supabaseFetch(
    `/rest/v1/lab_profiles?select=role,active&id=eq.${encodeURIComponent(user.id)}&limit=1`,
    {},
    token
  );
  if (!response.ok) return { id: user.id, role: '', active: false };
  const rows = await response.json().catch(() => []);
  const me = Array.isArray(rows) ? rows[0] : null;
  return { id: user.id, role: me?.role || '', active: me?.active !== false };
}

export default async function handler(req, res) {
  // Actions 從 github.com 的 runner 打過來；瀏覽器則是同源。開放 CORS 讓兩邊都能用。
  if (applyCors(req, res)) return;
  if (!['GET', 'PATCH'].includes(req.method)) return methodAllowed(res, ['GET', 'PATCH']);

  const siteUrl = siteUrlFromRequest(req);

  // --- GET：公開讀（Actions 用這條） ------------------------------------
  if (req.method === 'GET') {
    const policy = await readPolicy();
    // 第 4 段（權限的安全修正）跑了沒。系統設定頁據此提醒管理員補跑。
    const anon = supabaseConfig(false);
    const securityFixReady = anon ? await probeSchemaVersion(anon.url, anon) : true;
    return sendJson(res, 200, {
      securityFixReady,
      version: APP_VERSION,
      autoUpdate: policy.autoUpdate,
      // schemaReady:false 代表還沒跑第 3 段 SQL。介面要據此提示，
      // 而不是丟一個看不懂的錯誤。
      schemaReady: policy.schemaReady,
      backendConfigured: policy.configured,
      siteUrl,
      // 給人看的說明：維護者把這個值填進 GitHub 的 LAB_SITE_URL 變數就能生效。
      hint: siteUrl
        ? `若 GitHub 排程讀不到這個開關，請把 LAB_SITE_URL 設成 ${siteUrl}`
        : '讀不到這個網站的網址'
    });
  }

  // --- PATCH：只有管理員能改 --------------------------------------------
  const token = requireUserToken(req, res);
  if (!token) return;

  const me = await callerRole(token);
  // 認不出身分 = token 無效或過期。回 401 讓前端可以去重新登入，
  // 而不是回 403 讓他以為自己權限不足（那會查錯方向）。
  if (!me.id) {
    return sendJson(res, 401, { error: 'invalid_token', message: '登入狀態已失效，請重新登入。' });
  }
  if (!me.active) {
    return sendJson(res, 403, { error: 'forbidden', message: '你的帳號已被停用。' });
  }
  if (!ADMIN_ROLES.has(me.role)) {
    return sendJson(res, 403, { error: 'forbidden', message: '只有管理員可以改變自動更新設定。' });
  }

  const body = await readJsonBody(req);
  if (!body || typeof body.autoUpdate !== 'boolean') {
    return sendJson(res, 422, {
      error: 'invalid_policy',
      message: 'autoUpdate 必須是 true 或 false。'
    });
  }

  // 用使用者自己的 token 寫，讓 RLS 一起把關（不多開一條 secret 的寫入路徑）。
  const response = await supabaseFetch('/rest/v1/lab_settings?id=eq.1', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      auto_update_enabled: body.autoUpdate,
      updated_at: new Date().toISOString()
    })
  }, token);

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const text = JSON.stringify(payload);
    // 欄位不存在 → 引導使用者去補跑第 3 段 SQL，而不是丟一個 500。
    if (payload?.code === '42703' || /auto_update_enabled/.test(text)) {
      return sendJson(res, 409, {
        error: 'schema_outdated',
        message: '資料庫還缺「自動更新開關」這個欄位。請回到引導網頁第 4 步「建立資料表」，把第 3 段語法貼進 Supabase 的 SQL Editor 執行。'
      });
    }
    return sendJson(res, response.status, { error: 'policy_update_failed', details: payload });
  }

  const row = Array.isArray(payload) ? payload[0] : payload;
  return sendJson(res, 200, {
    autoUpdate: row?.auto_update_enabled !== false,
    siteUrl,
    updatedAt: row?.updated_at || new Date().toISOString()
  });
}
