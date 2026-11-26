// /api/config：前端啟動時要問的「這台伺服器連到哪個資料庫、叫什麼名字」。
//
// 為什麼要回研究室名稱：
//   登入畫面上如果寫著別的研究室名稱或什麼都沒有，助理會不確定自己開的是
//   不是正確的網站。回傳這裡設定的名稱，畫面就能顯示「你正在登入 XX 研究室」。
//
// 為什麼不含 secret 金鑰：
//   這支端點的結果會送到瀏覽器。secret / service_role 金鑰能繞過權限規則，
//   絕對不能出現在瀏覽器拿得到的東西裡。這裡只回「前端用來登入的那把」。
//
// 為什麼需要 setupComplete：
//   第一次打開時要直接顯示設定精靈，而不是先顯示登入畫面讓人卡住。

import { sendJson, supabaseConfig, supabaseHeaders, applyCors } from './_supabase.js';
import { APP_VERSION, APP_DISPLAY_NAME } from '../src/lib/app-info.js';

export default async function handler(req, res) {
  // 引導網頁從別的網域打這支，需要 CORS 標頭（見 _supabase.js 的說明）。
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });

  const config = supabaseConfig(false);
  if (!config) {
    return sendJson(res, 200, {
      app: APP_DISPLAY_NAME,
      version: APP_VERSION,
      backendConfigured: false,
      setupComplete: false,
      organizationName: '',
      supabaseUrl: '',
      anonKey: ''
    });
  }

  // 讀設定與完成狀態。兩者都可能因為權限或資料表不存在而拿不到，
  // 所以任何一種失敗都退回「還沒設定」，不讓 /api/config 變成 500。
  let setupComplete = false;
  let organizationName = '';
  const secret = supabaseConfig(true);
  if (secret) {
    try {
      const response = await fetch(
        `${config.url}/rest/v1/lab_settings?id=eq.1&select=organization_name,setup_completed_at`,
        { headers: supabaseHeaders(secret), signal: AbortSignal.timeout(8000) }
      );
      if (response.ok) {
        const rows = await response.json();
        setupComplete = Boolean(rows?.[0]?.setup_completed_at);
        organizationName = rows?.[0]?.organization_name || '';
      }
    } catch { /* 資料庫還沒建好或連不上，當作還沒設定 */ }
  }

  return sendJson(res, 200, {
    app: APP_DISPLAY_NAME,
    version: APP_VERSION,
    backendConfigured: true,
    setupComplete,
    organizationName,
    supabaseUrl: config.url,
    anonKey: config.key
  });
}
