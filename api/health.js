// /api/health：給「這個網站活著嗎」用的最輕量端點。
//
// 引導網頁（wizard）會打這支來確認使用者的部署成功了，
// 所以回應必須穩定、快、且不依賴資料庫（資料庫可能睡著或被暫停）。
// 這也讓 Vercel 的監控或外部 uptime 檢查有東西可以打。

import { sendJson, describeConfig, applyCors } from './_supabase.js';
import { APP_NAME, APP_DISPLAY_NAME, APP_VERSION } from '../src/lib/app-info.js';

export default function handler(req, res) {
  // 引導網頁從別的網域打這支，需要 CORS 標頭（見 _supabase.js 的說明）。
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
  const config = describeConfig();
  return sendJson(res, 200, {
    // wizard 用 app 欄位比對「這是不是我們的系統」
    app: APP_NAME,
    displayName: APP_DISPLAY_NAME,
    version: APP_VERSION,
    status: 'ok',
    environment: process.env.VERCEL_ENV || 'local',
    // 只說「設定了沒」，不回傳金鑰
    backendConfigured: config.ready,
    keyStyle: config.keyStyle,
    serverTime: new Date().toISOString()
  });
}
