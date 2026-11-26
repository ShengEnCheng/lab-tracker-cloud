// 成員帳號管理：列出、建立、修改。
//
// 這支改過兩個地方，都是產品化必須修的：
//
// 1) 原本建立使用者時，若呼叫端沒帶密碼，會用一組寫死在程式裡的預設密碼
//    （而且那段程式碼在公開 repo 裡）。那等於每個部署都有同一個已知密碼，
//    任何人只要知道 email 就能登入。現在改成：沒帶密碼就由伺服器產生一組
//    隨機密碼並在回應裡回傳一次，讓管理者複製給當事人。
//
// 2) 建立帳號前先確認呼叫者是管理員。原本只靠資料庫端的 RLS 擋，
//    但這支用的是 secret 金鑰（繞過 RLS），所以權限必須在伺服器端自己判斷。

import { randomBytes } from 'node:crypto';
import {
  methodAllowed, readJsonBody, requireUserToken, sendJson, supabaseFetch, supabaseServerFetch
} from './_supabase.js';

const PROFILE_FIELDS = 'id,email,display_name,member_code,role,active,created_at,updated_at';
const ADMIN_ROLES = new Set(['admin', 'backup_admin']);
const ROLES = new Set(['researcher', 'study_manager', 'admin', 'backup_admin']);

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// 產生一組好念、好打的臨時密碼：避開 l/1/I、O/0 這些容易看錯的字元。
export function generateTemporaryPassword(length = 12) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  // 保證至少有一個數字與一個字母，符合多數密碼政策。
  return out;
}

// 查出「發出這個請求的人」的角色。
//
// 一定要先用 token 向 Auth 問出使用者 id，再只查那一列。
// 以前這裡直接查 lab_profiles 取第一列 —— 但 RLS 讓每個在職成員都讀得到
// **所有人**的資料列，第一列通常是最早建立的管理員。於是任何一般成員都被
// 當成管理員：能新增管理員，甚至拿管理員的 email「新增成員」，伺服器會重設
// 那個人的密碼並把新密碼回給他 —— 等於接管管理員帳號。
// （api/update-policy.js 的 callerRole 也是同一個寫法，兩邊要一致。）
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
  const row = Array.isArray(rows) ? rows[0] : null;
  return { id: user.id, role: row?.role || '', active: Boolean(row?.active) };
}

function forbidden(res) {
  return sendJson(res, 403, {
    error: 'forbidden',
    message: '只有管理員可以管理成員帳號。'
  });
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return methodAllowed(res, ['GET', 'POST', 'PATCH']);
  const token = requireUserToken(req, res);
  if (!token) return;

  try {
    const me = await callerRole(token);
    // 認不出身分 = token 無效或過期：回 401 讓前端去重新登入，而不是 403。
    if (!me.id) {
      return sendJson(res, 401, { error: 'invalid_token', message: '登入狀態已失效，請重新登入。' });
    }
    if (!me.active) {
      return sendJson(res, 403, { error: 'forbidden', message: '你的帳號沒有權限或已被停用。' });
    }

    if (req.method === 'GET') {
      const query = new URLSearchParams({ select: PROFILE_FIELDS, order: 'display_name.asc,email.asc' });
      const response = await supabaseFetch(`/rest/v1/lab_profiles?${query}`, {}, token);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const raw = JSON.stringify(payload).toLowerCase();
        return sendJson(res, raw.includes('not_authorized') ? 403 : response.status, {
          error: raw.includes('not_authorized') ? 'forbidden' : 'profile_operation_failed',
          details: payload
        });
      }
      return sendJson(res, 200, { profiles: payload });
    }

    // 以下都是寫入，只有管理員能做。
    if (!ADMIN_ROLES.has(me.role)) return forbidden(res);

    const body = await readJsonBody(req);
    if (!body || typeof body.email !== 'string' || !body.email.trim()) {
      return sendJson(res, 422, { error: 'invalid_profile', message: 'email 為必要欄位。' });
    }

    const email = body.email.trim().toLowerCase();
    const role = String(body.role || 'researcher');
    if (!ROLES.has(role)) {
      return sendJson(res, 422, { error: 'invalid_role', message: `角色必須是 ${[...ROLES].join('、')} 其中之一。` });
    }

    // PATCH：只更新資料庫裡的成員資料，不動 Auth 帳號與密碼。
    if (req.method === 'PATCH') {
      if (!isUuid(body.id)) {
        return sendJson(res, 422, { error: 'invalid_profile', message: '修改成員需要有效的 id。' });
      }
      const patch = { updated_at: new Date().toISOString() };
      if (body.display_name !== undefined) patch.display_name = String(body.display_name).slice(0, 60);
      if (body.member_code !== undefined) patch.member_code = String(body.member_code).slice(0, 32);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      if (body.role !== undefined) patch.role = role;

      const response = await supabaseServerFetch(`/rest/v1/lab_profiles?id=eq.${body.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return sendJson(res, response.status, { error: 'profile_update_failed', details: payload });
      }
      return sendJson(res, 200, { profile: Array.isArray(payload) ? payload[0] : payload });
    }

    // POST：建立帳號（需要時一併建立 Auth 使用者）
    let userId = body.id;
    let generatedPassword = '';

    if (!userId || !isUuid(userId)) {
      let existingId = '';
      try {
        const usersRes = await supabaseServerFetch('/auth/v1/admin/users?per_page=200');
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          const existing = (usersData.users || []).find(user => user.email && user.email.toLowerCase() === email);
          if (existing?.id) existingId = existing.id;
        }
      } catch (err) {
        console.warn('查詢既有 Auth 使用者失敗:', err);
      }

      if (existingId) {
        userId = existingId;
        // 已有帳號卻重新加入成員：重設密碼，讓管理者拿得到一組能用的。
        const password = String(body.password || '').trim() || generateTemporaryPassword();
        generatedPassword = String(body.password || '').trim() ? '' : password;
        const updateRes = await supabaseServerFetch(`/auth/v1/admin/users/${existingId}`, {
          method: 'PUT',
          body: JSON.stringify({ password, email_confirm: true })
        });
        if (!updateRes.ok) {
          const detail = await updateRes.text().catch(() => '');
          return sendJson(res, updateRes.status || 502, {
            error: 'password_reset_failed',
            message: `既有帳號的密碼重設失敗（HTTP ${updateRes.status}）：${detail.slice(0, 200)}`
          });
        }
      } else {
        // 沒帶密碼就產生一組隨機的。絕不使用任何固定的預設值。
        const password = String(body.password || '').trim() || generateTemporaryPassword();
        if (password.length < 8) {
          return sendJson(res, 422, { error: 'weak_password', message: '密碼至少需要 8 個字元。' });
        }
        generatedPassword = String(body.password || '').trim() ? '' : password;

        const createRes = await supabaseServerFetch('/auth/v1/admin/users', {
          method: 'POST',
          body: JSON.stringify({ email, password, email_confirm: true })
        });
        const created = await createRes.json().catch(() => ({}));
        if (!createRes.ok || !created?.id) {
          const detail = created?.message || created?.msg || created?.error_description || '';
          return sendJson(res, createRes.status || 400, {
            error: 'user_creation_failed',
            message: `建立登入帳號失敗（HTTP ${createRes.status}）：${detail}`
          });
        }
        userId = created.id;
      }
    }

    const profileResponse = await supabaseServerFetch('/rest/v1/lab_profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: userId,
        email,
        display_name: String(body.display_name || body.member_name || '').slice(0, 60),
        member_code: String(body.member_code || body.memberCode || '').slice(0, 32),
        role,
        active: body.active === undefined ? true : Boolean(body.active),
        updated_at: new Date().toISOString()
      })
    });
    const profilePayload = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok) {
      return sendJson(res, profileResponse.status, { error: 'profile_write_failed', details: profilePayload });
    }

    return sendJson(res, 200, {
      profile: Array.isArray(profilePayload) ? profilePayload[0] : profilePayload,
      // 只在「伺服器自己產生的密碼」時回傳，且只回傳這一次。
      generatedPassword: generatedPassword || undefined
    });
  } catch (error) {
    if (error.message === 'supabase_not_configured') {
      return sendJson(res, 503, { error: 'backend_not_configured', message: '尚未設定 Supabase 環境變數。' });
    }
    console.error('profiles api error', error);
    return sendJson(res, 503, { error: 'service_unavailable', message: '成員服務暫時無法使用。' });
  }
}
