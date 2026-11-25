// /api/setup-status：這個部署「準備到哪裡了」的總體檢。
//
// 為什麼需要這支端點：
//   引導網頁（wizard）要能在任何階段回答「還缺什麼」，
//   包跨「環境變數沒設」「資料庫連不上」「資料表沒建」「已經完成設定」。
//   使用者不需要看懂錯誤訊息，只要看到「第 3 步還沒完成，原因是…」。
//
// 安全原則：
//   這支端點不需要登入（否則就雞生蛋蛋生雞），所以只回報「有／沒有」，
//   不回傳任何金鑰、也不回傳任何成員的個人資料。

import { sendJson, describeConfig, supabaseConfig } from './_supabase.js';
import { APP_VERSION, APP_NAME, APP_DISPLAY_NAME } from '../src/lib/app-info.js';

const TABLE_PROBES = ['lab_state', 'lab_profiles', 'lab_settings'];

async function probeTable(url, key, table) {
  try {
    const response = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    if (response.ok) return { name: table, exists: true, status: response.status };
    let code = '';
    try { code = JSON.parse(text)?.code || ''; } catch { /* 非 JSON */ }
    if (response.status === 404 && code === 'PGRST205') return { name: table, exists: false, status: 404 };
    return { name: table, exists: false, status: response.status, message: text.slice(0, 200) };
  } catch (error) {
    return { name: table, exists: false, status: 0, message: String(error?.message || error) };
  }
}

// 讀設定列。用 secret 金鑰，因為匿名讀不到（RLS 只給管理員）。
async function readSettings(config) {
  const secret = supabaseConfig(true);
  if (!secret) return null;
  try {
    const response = await fetch(`${config.url}/rest/v1/lab_settings?id=eq.1&select=organization_name,organization_code,setup_completed_at`, {
      headers: { apikey: secret.key },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function readAdminCount(config) {
  const secret = supabaseConfig(true);
  if (!secret) return null;
  try {
    const response = await fetch(`${config.url}/rest/v1/lab_profiles?role=eq.admin&active=is.true&select=id`, {
      headers: { apikey: secret.key, Prefer: 'count=exact' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return null;
    const range = response.headers.get('content-range') || '';
    const match = range.match(/\/(\d+)/);
    if (match) return Number(match[1]);
    const rows = await response.json();
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });

  const config = describeConfig();

  // 第一關：環境變數。沒設定就不用往下打了。
  if (!config.ready) {
    return sendJson(res, 200, {
      app: APP_NAME,
      displayName: APP_DISPLAY_NAME,
      version: APP_VERSION,
      backendConfigured: false,
      setupComplete: false,
      organization: null,
      checks: {
        environment: {
          ok: false,
          message: '這個網站還沒有連到資料庫（Supabase 環境變數沒設定）。如果你是照引導網頁做的，請先完成第 3 步。'
        }
      }
    });
  }

  // 第二關：資料庫連得到嗎（順便確認專案沒被暫停）。
  const anon = supabaseConfig(false);
  let authReachable = false;
  let authMessage = '';
  try {
    const response = await fetch(`${config.url}/auth/v1/health`, {
      headers: { apikey: anon.key },
      signal: AbortSignal.timeout(10000)
    });
    authReachable = response.ok;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      authMessage = text.slice(0, 200);
    }
  } catch (error) {
    authMessage = String(error?.message || error);
  }

  if (!authReachable) {
    return sendJson(res, 200, {
      app: APP_NAME,
      displayName: APP_DISPLAY_NAME,
      version: APP_VERSION,
      backendConfigured: true,
      setupComplete: false,
      organization: null,
      checks: {
        database: {
          ok: false,
          message: '連不到資料庫。最常見的原因是免費專案閒置超過 7 天被暫停了 —— 請到 Supabase 後台按 Restore 喚醒，資料不會不見。',
          detail: authMessage
        }
      }
    });
  }

  // 第三關：資料表建好了嗎。
  const probes = await Promise.all(TABLE_PROBES.map(table => probeTable(config.url, anon.key, table)));
  const missing = probes.filter(probe => !probe.exists).map(probe => probe.name);
  const schemaInstalled = missing.length === 0;

  if (!schemaInstalled) {
    return sendJson(res, 200, {
      app: APP_NAME,
      displayName: APP_DISPLAY_NAME,
      version: APP_VERSION,
      backendConfigured: true,
      setupComplete: false,
      organization: null,
      checks: {
        database: { ok: true, message: '資料庫連線正常。' },
        schema: {
          ok: false,
          message: missing.includes('lab_settings') && probes.some(p => p.name === 'lab_state' && p.exists)
            ? '主要資料表已經建好，但還缺第二段設定語法（002）。請回到引導網頁第 4 步，把第二段也貼進 SQL Editor 執行。'
            : '資料表還沒建立。請回到引導網頁第 4 步，把語法貼進 Supabase 的 SQL Editor 執行。',
          missing
        }
      }
    });
  }

  // 第四關：完成設定了嗎。
  const settings = await readSettings(config);
  const adminCount = await readAdminCount(config);
  const setupComplete = Boolean(settings?.setup_completed_at);

  return sendJson(res, 200, {
    app: APP_NAME,
    version: APP_VERSION,
    backendConfigured: true,
    setupComplete,
    organization: settings?.organization_name
      ? { name: settings.organization_name, code: settings.organization_code || '' }
      : null,
    adminExists: (adminCount || 0) > 0,
    checks: {
      // 全部正常時也要有 environment 這一項：呼叫端（引導網頁）會固定讀
      // checks.environment.ok，缺了會變成 undefined 而被誤判成失敗。
      environment: { ok: true, message: '環境變數都已設定。' },
      database: { ok: true, message: '資料庫連線正常。' },
      schema: { ok: true, message: '資料表都在。' },
      setup: setupComplete
        ? { ok: true, message: '已經完成設定，可以直接登入使用。' }
        : { ok: false, message: '還沒有人建立管理員帳號。請打開這個網站，照畫面完成第一次設定。' }
    }
  });
}
