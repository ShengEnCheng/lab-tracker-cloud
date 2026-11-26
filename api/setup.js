// /api/setup：第一次設定 —— 建立研究室設定、第一個管理員帳號、以及初始資料。
//
// 為什麼這支端點需要 secret 金鑰：
//   建立 Auth 使用者必須走 /auth/v1/admin/users，那只有 secret / service_role
//   能做。而「誰能成為第一個管理員」不能由任何匿名請求決定，所以這裡用
//   「lab_settings 還沒有 setup_completed_at」當鎖：一旦設定過，任何請求都被擋。
//
// 為什麼初始資料用直接寫入而不是呼叫 import_lab_state：
//   那個 RPC 用 auth.uid() 判斷身分，而 secret 金鑰呼叫時沒有 uid，會被判成
//   not_authorized。直接寫入（service_role 繞過 RLS）搭配明確的 updated_by，
//   效果相同且意圖更清楚。

import { sendJson, readJsonBody, supabaseConfig, supabaseHeaders } from './_supabase.js';
import { validateSetupInput } from '../src/lib/setup-validation.js';
import { buildInitialState, SCHEMA_VERSION } from '../src/lib/initial-state.js';
import { APP_VERSION } from '../src/lib/app-info.js';

// 標頭一律用 supabaseHeaders()：舊制金鑰（eyJ… 的 anon / service_role）要同時放進
// Authorization 才有對應的權限，只放 apikey 會被當成匿名請求 —— 讀到 [] 而不是報錯。
// 詳見 _supabase.js 的 buildHeaders()。
function secretHeaders(secret, extra = {}) {
  return supabaseHeaders(secret, '', extra);
}

async function sbFetch(config, secret, path, options = {}) {
  return fetch(`${config.url}${path}`, {
    ...options,
    headers: secretHeaders(secret, options.headers),
    signal: AbortSignal.timeout(15000)
  });
}

// 找出是否已經有人完成設定。用 secret 讀，因為匿名讀不到資料列。
async function readSetupLock(config, secret) {
  const response = await sbFetch(config, secret, '/rest/v1/lab_settings?id=eq.1&select=setup_completed_at,organization_name');
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { error: `讀取設定狀態失敗（HTTP ${response.status}）：${text.slice(0, 200)}` };
  }
  const rows = await response.json();
  const row = rows?.[0];
  return {
    completed: Boolean(row?.setup_completed_at),
    organizationName: row?.organization_name || ''
  };
}

// 建立 Auth 使用者。若 email 已存在則回傳既有使用者（讓重試可以成功）。
async function ensureAuthUser(config, secret, { email, password }) {
  const listResponse = await sbFetch(config, secret, '/auth/v1/admin/users?per_page=200');
  if (listResponse.ok) {
    const payload = await listResponse.json().catch(() => ({}));
    const existing = (payload.users || []).find(user => (user.email || '').toLowerCase() === email);
    if (existing?.id) {
      // 已有帳號：重設密碼，確保這次設定的人真的能登入。
      const updateResponse = await sbFetch(config, secret, `/auth/v1/admin/users/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password, email_confirm: true })
      });
      if (!updateResponse.ok) {
        const text = await updateResponse.text().catch(() => '');
        return { error: `更新既有帳號的密碼失敗（HTTP ${updateResponse.status}）：${text.slice(0, 200)}` };
      }
      return { userId: existing.id, created: false };
    }
  }

  const createResponse = await sbFetch(config, secret, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !created?.id) {
    const detail = created?.message || created?.msg || created?.error_description || JSON.stringify(created).slice(0, 200);
    return { error: `建立管理員帳號失敗（HTTP ${createResponse.status}）：${detail}` };
  }
  return { userId: created.id, created: true };
}

export default async function handler(req, res) {
  if (req.method === 'POST') return handleSetup(req, res);
  if (req.method === 'GET') return handleStatus(req, res);
  return sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET', 'POST'] });
}

// GET /api/setup：給設定畫面問「我需不需要做第一次設定」。
async function handleStatus(req, res) {
  const config = supabaseConfig(false);
  const secret = supabaseConfig(true);
  if (!config || !secret) {
    return sendJson(res, 200, { canSetup: false, reason: 'backend_not_configured' });
  }
  const lock = await readSetupLock(config, secret);
  if (lock.error) return sendJson(res, 200, { canSetup: false, reason: 'backend_unreachable', detail: lock.error });
  return sendJson(res, 200, {
    canSetup: !lock.completed,
    setupComplete: lock.completed,
    organizationName: lock.organizationName || '',
    version: APP_VERSION
  });
}

async function handleSetup(req, res) {
  const config = supabaseConfig(false);
  const secret = supabaseConfig(true);
  if (!config || !secret) {
    return sendJson(res, 503, {
      error: 'backend_not_configured',
      message: '這個網站還沒連上資料庫。請確認 Supabase 環境變數都設好了。'
    });
  }

  const body = await readJsonBody(req);
  const validation = validateSetupInput(body);
  if (!validation.ok) {
    return sendJson(res, 422, { error: 'invalid_setup', errors: validation.errors, message: '有幾個欄位需要修正。' });
  }
  const input = validation.value;

  // 先確認資料表在不在，不在就給明確指引，而不是丟一個看不懂的 SQL 錯誤。
  const probe = await sbFetch(config, secret, '/rest/v1/lab_settings?select=id&limit=1');
  if (probe.status === 404) {
    const text = await probe.text().catch(() => '');
    if (text.includes('PGRST205')) {
      return sendJson(res, 503, {
        error: 'schema_missing',
        message: '資料表還沒建立。請先到 Supabase 的 SQL Editor 執行建表語法（引導網頁第 4 步「建立資料表」），再回來設定。'
      });
    }
  }

  // 鎖：已經設定過就不能再設定，否則任何人都能把管理員換成自己。
  const lock = await readSetupLock(config, secret);
  if (lock.error) {
    return sendJson(res, 503, { error: 'backend_unreachable', message: lock.error });
  }
  if (lock.completed) {
    return sendJson(res, 409, {
      error: 'already_setup',
      message: '這個系統已經完成設定了。如果你忘記密碼，請到 Supabase 後台重設，或聯絡維護者。'
    });
  }

  // 1) 建立管理員帳號
  const auth = await ensureAuthUser(config, secret, { email: input.adminEmail, password: input.adminPassword });
  if (auth.error) return sendJson(res, 502, { error: 'auth_user_failed', message: auth.error });

  // 2) 寫入成員資料（角色 admin）
  const profileResponse = await sbFetch(config, secret, '/rest/v1/lab_profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      id: auth.userId,
      email: input.adminEmail,
      display_name: input.adminName,
      member_code: input.organizationCode || '',
      role: 'admin',
      active: true
    })
  });
  if (!profileResponse.ok) {
    const text = await profileResponse.text().catch(() => '');
    return sendJson(res, 502, {
      error: 'profile_write_failed',
      message: `建立管理員資料失敗（HTTP ${profileResponse.status}）：${text.slice(0, 300)}`
    });
  }

  // 3) 寫入初始資料
  const initialState = buildInitialState({ withSampleData: input.withSampleData });
  const stateResponse = await sbFetch(config, secret, '/rest/v1/lab_state?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: 1,
      data: initialState,
      revision: 1,
      schema_version: SCHEMA_VERSION,
      updated_by: auth.userId
    })
  });
  if (!stateResponse.ok) {
    const text = await stateResponse.text().catch(() => '');
    return sendJson(res, 502, {
      error: 'state_write_failed',
      message: `建立初始資料失敗（HTTP ${stateResponse.status}）：${text.slice(0, 300)}`
    });
  }

  // 4) 寫入研究室設定，並標記完成（這就是那把鎖）
  const now = new Date().toISOString();
  const settingsResponse = await sbFetch(config, secret, '/rest/v1/lab_settings?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: 1,
      organization_name: input.organizationName,
      organization_code: input.organizationCode,
      contact_email: input.contactEmail,
      setup_completed_at: now,
      updated_at: now
    })
  });
  if (!settingsResponse.ok) {
    const text = await settingsResponse.text().catch(() => '');
    return sendJson(res, 502, {
      error: 'settings_write_failed',
      message: `儲存研究室設定失敗（HTTP ${settingsResponse.status}）：${text.slice(0, 300)}`
    });
  }

  // 5) 稽核紀錄（失敗不影響設定結果，只是少一筆紀錄）
  await sbFetch(config, secret, '/rest/v1/lab_audit_logs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      request_id: crypto.randomUUID(),
      action: 'change',
      base_revision: 0,
      resulting_revision: 1,
      actor_id: auth.userId,
      entity_summary: {
        event: 'setup_complete',
        organizationName: input.organizationName,
        withSampleData: input.withSampleData,
        appVersion: APP_VERSION
      }
    })
  }).catch(() => null);

  return sendJson(res, 200, {
    ok: true,
    message: '設定完成，可以開始使用了。',
    organization: { name: input.organizationName, code: input.organizationCode },
    adminEmail: input.adminEmail,
    revision: 1
  });
}
