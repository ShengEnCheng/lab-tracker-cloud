// 假的 Supabase：讓測試可以在不碰真實資料庫的情況下，跑完整的設定流程。
//
// 為什麼需要它：
//   api/setup.js 會做四件事 —— 建立 Auth 使用者、寫成員、寫初始資料、寫研究室設定。
//   這四件事都依賴 Supabase 的真實行為（RLS、on_conflict、Prefer 標頭）。
//   用真的資料庫測無法重複（設定一旦完成就有鎖），也會污染使用者的專案。
//   所以在記憶體裡模擬 PostgREST 與 Auth 的關鍵行為。
//
// 模擬範圍刻意最小：只實作這個專案真的會用到的語法與標頭。

import http from 'node:http';

function uuid() {
  return crypto.randomUUID();
}

// 解析 PostgREST 的 query string：欄位選擇、篩選（field=eq.value）、on_conflict
function parseQuery(searchParams) {
  const select = searchParams.get('select') || '*';
  const filters = {};
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select' || key === 'on_conflict' || key === 'order' || key === 'limit') continue;
    const match = String(value).match(/^eq\.(.*)$/);
    if (match) filters[key] = match[1];
  }
  return { select, filters, order: searchParams.get('order'), limit: searchParams.get('limit'), onConflict: searchParams.get('on_conflict') };
}

function applyFilters(rows, filters) {
  return rows.filter(row => Object.entries(filters).every(([key, value]) => {
    if (value === 'true') return row[key] === true;
    if (value === 'false') return row[key] === false;
    return String(row[key] ?? '') === value;
  }));
}

function pick(rows, select) {
  if (select === '*' || !select) return rows;
  const fields = select.split(',').map(field => field.trim()).filter(Boolean);
  return rows.map(row => {
    const out = {};
    for (const field of fields) out[field] = row[field];
    return out;
  });
}

// 伺服器金鑰有沒有生效（照真實 Supabase 的行為）：
//   新制 sb_secret_…：放在 apikey 就生效。
//   舊制 service_role（eyJ… 的 JWT）：角色寫在 token 裡，**一定要放進 Authorization**。
//     只放 apikey 會被當成匿名 —— RLS 擋光、回 200 + []，不報錯。
// 不模擬這件事，「舊制金鑰只放 apikey」的程式在測試裡會一路綠燈，上線才壞。
function serverKeyAccepted(serverKey, apikey, bearer) {
  if (!serverKey) return false;
  if (serverKey.startsWith('eyJ')) return bearer === serverKey;
  return apikey === serverKey || bearer === serverKey;
}

export async function startMockSupabase({ tables = null, secretKey = null } = {}) {
  const state = {
    authUsers: [],
    // 預設模擬「資料表都已建立」的狀態
    tables: tables || {
      lab_profiles: [],
      lab_state: [],
      lab_settings: [],
      lab_audit_logs: [],
      lab_backups: [],
      lab_backup_runs: []
    },
    requests: [],
    // 用來模擬「資料庫被暫停」
    down: false,
    // 伺服器金鑰（模擬 secret / service_role）：帶著它就能繞過 RLS
    secretKey: secretKey || 'sb_secret_test_key',
    // 已登入使用者的有效 token。真實 Supabase 由 JWT 簽章驗證；
    // 這裡用白名單模擬「只有真的登入過的人才有有效 token」。
    authTokens: []
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    state.requests.push({ method: req.method, path, headers: req.headers, at: Date.now() });

    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    // 讀 request body
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;

    if (state.down) {
      return send(503, { message: 'project is paused' });
    }

    // --- Auth health（引導網頁與 setup-status 會打）---
    if (path === '/auth/v1/health') {
      return send(200, { version: 'v2.198.0', name: 'GoTrue' });
    }

    // --- 登入（前端直接跟 Supabase Auth 要 JWT，不經過我們的 API）---
    //
    // 這是「設定完成之後，研究室成員真的能登入嗎」那條路徑的起點。
    // 真實的 GoTrue 會驗密碼並簽發 JWT；這裡發一個可辨識的 token，
    // 並把它登記到 authTokens，讓後面的資料請求能被接受。
    if (path === '/auth/v1/token' && req.method === 'POST') {
      const email = String(body?.email || '').toLowerCase();
      const password = String(body?.password || '');
      const user = state.authUsers.find(item => item.email === email && item.password === password);
      if (!user) {
        return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      const token = `token-${user.id}`;
      if (!state.authTokens.includes(token)) state.authTokens.push(token);
      return send(200, {
        access_token: token,
        token_type: 'bearer',
        expires_in: 3600,
        user: { id: user.id, email: user.email }
      });
    }

    // --- Auth：用 token 問「這個人是誰」（GET /auth/v1/user）---
    //
    // api/profile.js 與 api/update-policy.js 都靠這支確認呼叫者身分。
    // 為什麼不能只查 lab_profiles 取第一列：lab_profiles 有多列，
    // 第一列很可能是管理員 —— 那樣任何登入的人都被當成管理員，
    // 這是真正的權限漏洞，而且在畫面上完全看不出來。所以要模擬
    // 「token 換出使用者 id」這件事，讓那種寫法在測試裡就失敗。
    if (path === '/auth/v1/user' && req.method === 'GET') {
      const authHeader = String(req.headers.authorization || '');
      const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!rawToken) {
        return send(401, { message: 'invalid claim: missing sub claim' });
      }
      // 伺服器金鑰不是使用者身分。
      if (state.secretKey && rawToken === state.secretKey) {
        return send(403, { message: 'This endpoint requires a user token' });
      }
      if (!state.authTokens.includes(rawToken)) {
        return send(401, { message: 'invalid claim: missing sub claim', code: 'invalid_jwt' });
      }
      const id = rawToken.replace(/^token-/, '');
      const user = state.authUsers.find(item => item.id === id);
      // 測試裡常常只登記 token 而沒有建 authUsers 帳號（模擬既有使用者），
      // 那就用 token 裡的 id 回一個最小身分。
      return send(200, { id, email: user ? user.email : `${id}@example.test` });
    }

    // --- Auth admin users ---
    if (path === '/auth/v1/admin/users' && req.method === 'GET') {
      return send(200, { users: state.authUsers.map(user => ({ id: user.id, email: user.email, email_confirmed_at: user.email_confirm ? new Date().toISOString() : null })) });
    }
    if (path === '/auth/v1/admin/users' && req.method === 'POST') {
      if (!body?.email) return send(422, { message: 'email required' });
      const existing = state.authUsers.find(user => user.email === String(body.email).toLowerCase());
      if (existing) return send(422, { message: 'User already registered', error_code: 'email_exists' });
      const user = {
        id: uuid(),
        email: String(body.email).toLowerCase(),
        password: body.password,
        email_confirm: Boolean(body.email_confirm)
      };
      state.authUsers.push(user);
      return send(200, { id: user.id, email: user.email });
    }
    const userMatch = path.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (userMatch && req.method === 'PUT') {
      const user = state.authUsers.find(item => item.id === userMatch[1]);
      if (!user) return send(404, { message: 'user not found' });
      if (body?.password) user.password = body.password;
      return send(200, { id: user.id });
    }

    // --- PostgREST ---
    const restMatch = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (restMatch) {
      const table = restMatch[1];
      const query = parseQuery(url.searchParams);

      // 驗證身分標頭。真實的 Supabase 會這樣做，而 api/data.js 依賴它：
      // 它把使用者的 JWT 傳進來，PostgREST 用它判斷 auth.uid()，
      // 假的 token 會回 401 而不是讓請求穿過去。
      //
      // 為什麼要模擬：如果 mock 不驗 token，那麼「假 token 也能讀到資料」
      // 這個嚴重的權限漏洞在測試裡永遠不會被抓到。
      const apikey = String(req.headers.apikey || '');
      if (!apikey) {
        return send(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
      }
      const authorization = String(req.headers.authorization || '');
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      // 伺服器金鑰（secret / service_role）通過；使用者 token 必須是真實存在的使用者
      // 三種身分，行為照真實 PostgREST（每一種都實測確認過）：
      //
      // 1. 伺服器金鑰（secret / service_role）→ 繞過 RLS，看得到全部資料
      // 2. 匿名（只有 publishable / anon 金鑰，沒有 Authorization）
      //    → RLS 擋光，回 200 但內容是 []。**不報錯**，這是最容易誤判的情況
      // 3. 帶了 Authorization 卻不是有效 token → 401 Invalid JWT
      //    （真實 Supabase 對假 token 就是這樣回）
      const serverKey = state.secretKey || '';
      const isServerKey = serverKeyAccepted(serverKey, apikey, bearer);
      const isKnownUserToken = Boolean(bearer) && state.authTokens.includes(bearer);
      if (bearer && !isServerKey && !isKnownUserToken) {
        return send(401, { message: 'Invalid JWT', code: 'PGRST301' });
      }
      // 匿名請求看到的是空的（RLS 擋掉），不是錯誤
      const anonymous = !isServerKey && !isKnownUserToken;

      if (!state.tables[table]) {
        // 真實 Supabase 對不存在的表回 404 + PGRST205
        return send(404, {
          code: 'PGRST205',
          details: null,
          hint: null,
          message: `Could not find the table 'public.${table}' in the schema cache`
        });
      }

      const rows = state.tables[table];

      // 帶有效使用者 token 的請求，要看得到「他自己那一列」（RLS 的效果）。
      // api/ 用它來判斷呼叫者的角色，所以不能一律回空陣列。
      if (req.method === 'GET' && isKnownUserToken) {
        const matched = applyFilters(rows, query.filters);
        const limited = query.limit ? matched.slice(0, Number(query.limit)) : matched;
        return send(200, pick(limited, query.select));
      }

      if (req.method === 'GET') {
        if (anonymous) {
          // RLS 對匿名使用者什麼都不給。表存在，所以是 200 而不是 404。
          res.setHeader('content-range', '*/0');
          return send(200, []);
        }
        const matched = applyFilters(rows, query.filters);
        const limited = query.limit ? matched.slice(0, Number(query.limit)) : matched;
        res.setHeader('content-range', `0-${Math.max(0, limited.length - 1)}/${matched.length}`);
        return send(200, pick(limited, query.select));
      }

      if (req.method === 'POST') {
        const incoming = Array.isArray(body) ? body : [body];
        const prefer = req.headers.prefer || '';
        const upsert = prefer.includes('merge-duplicates');
        const results = [];
        for (const row of incoming) {
          const key = query.onConflict || 'id';
          const existingIndex = upsert ? rows.findIndex(item => item[key] === row[key]) : -1;
          if (existingIndex >= 0) {
            rows[existingIndex] = { ...rows[existingIndex], ...row };
            results.push(rows[existingIndex]);
          } else {
            const created = { id: row.id || uuid(), created_at: new Date().toISOString(), ...row };
            rows.push(created);
            results.push(created);
          }
        }
        if (prefer.includes('return=representation')) return send(201, results);
        return send(201, null);
      }

      if (req.method === 'PATCH') {
        const matched = applyFilters(rows, query.filters);
        for (const row of matched) Object.assign(row, body || {});
        if ((req.headers.prefer || '').includes('return=representation')) return send(200, matched);
        return send(204, null);
      }
    }

    // --- RPC ---
    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.slice('/rest/v1/rpc/'.length);

      // RPC 也要驗身分，理由和上面的 PostgREST 一樣：真實的函式是
      // security definer，靠 auth.uid() 判斷角色。不驗的話
      // 「未登入也能匯入」這種漏洞在測試裡抓不到。
      const rpcApikey = String(req.headers.apikey || '');
      const rpcAuth = String(req.headers.authorization || '');
      const rpcBearer = rpcAuth.startsWith('Bearer ') ? rpcAuth.slice(7).trim() : '';
      const rpcServerKey = state.secretKey || '';
      const isServerKey = serverKeyAccepted(rpcServerKey, rpcApikey, rpcBearer);
      const isKnownUserToken = Boolean(rpcBearer) && state.authTokens.includes(rpcBearer);
      if (rpcBearer && !isServerKey && !isKnownUserToken) {
        return send(401, { message: 'Invalid JWT', code: 'PGRST301' });
      }
      // token 的形式是 token-<user id>，還原出呼叫者
      const callerUserId = isKnownUserToken ? rpcBearer.replace(/^token-/, '') : null;

      // 建表語法的版本（第 4 段起才有）。state.schemaVersion = null 模擬「沒補跑第 4 段」：
      // 真實 PostgREST 對不存在的函式回 404 + PGRST202。匿名也能呼叫（004 有 grant 給 anon）。
      if (fn === 'lab_schema_version') {
        if (state.schemaVersion === null) {
          return send(404, { code: 'PGRST202', message: 'Could not find the function public.lab_schema_version without parameters in the schema cache' });
        }
        return send(200, state.schemaVersion ?? 4);
      }

      // 寫入共用資料（api/data.js 的 POST）。真實的函式有樂觀鎖：
      // 帶來的 base revision 跟資料庫的不一樣就丟 revision_conflict。
      if (fn === 'apply_lab_state_change') {
        const row = (state.tables.lab_state || [])[0];
        if (!row) return send(400, { message: 'no lab_state row' });
        const base = Number(body?.p_base_revision);
        const current = Number(row.revision || 0);
        if (Number.isFinite(base) && base !== current) {
          return send(400, {
            code: 'P0001',
            message: `revision_conflict: 資料已被其他人更新（目前 ${current}，你的是 ${base}）`
          });
        }
        row.data = body?.p_data ?? row.data;
        row.revision = current + 1;
        row.updated_at = new Date().toISOString();
        return send(200, { revision: row.revision, schema_version: row.schema_version || 1 });
      }

      // 匯入整份資料（api/import.js）。照 001_lab_state.sql:225 的語意：
      //   1. 只有 admin / backup_admin 能用（否則 not_authorized）
      //   2. 同一個 request_id 重送時是幂等的，不會匯入兩次
      //   3. 匯入前先存一份備份（kind='before_import'）
      //   4. revision + 1
      //
      // 這裡一定要真的實作，不能回一個假的成功：匯入最怕的就是
      // 「畫面說成功、資料其實沒進去」，那正是這個測試要抓的東西。
      if (fn === 'import_lab_state') {
        const requestId = String(body?.p_request_id || '');
        const data = body?.p_data;
        if (!requestId) return send(400, { message: 'p_request_id required' });
        if (!data || typeof data !== 'object') return send(400, { message: 'p_data required' });

        // 呼叫者身分：server 金鑰（secret）可以繞過，使用者 token 要查角色
        if (!isServerKey) {
          const profile = (state.tables.lab_profiles || []).find(item => item.id === callerUserId && item.active !== false);
          const role = profile?.role;
          if (role !== 'admin' && role !== 'backup_admin') {
            return send(403, { message: 'not_authorized' });
          }
        }

        // 幂等：同一個 request_id 只會生效一次
        const existing = (state.tables.lab_audit_logs || []).find(row => row.request_id === requestId);
        if (existing) {
          return send(200, { revision: existing.resulting_revision, requestId, idempotent: true });
        }

        const row = (state.tables.lab_state || [])[0];
        let nextRevision;
        let snapshotId = null;
        if (row) {
          snapshotId = uuid();
          state.tables.lab_backups = state.tables.lab_backups || [];
          state.tables.lab_backups.push({
            id: snapshotId,
            source_revision: row.revision,
            schema_version: row.schema_version || 1,
            data: JSON.parse(JSON.stringify(row.data)),
            kind: 'before_import',
            created_at: new Date().toISOString()
          });
          nextRevision = Number(row.revision || 0) + 1;
          row.data = data;
          row.revision = nextRevision;
          row.schema_version = data.schemaVersion || row.schema_version || 1;
          row.updated_at = new Date().toISOString();
        } else {
          nextRevision = 1;
          state.tables.lab_state = [{
            id: 1,
            data,
            revision: nextRevision,
            schema_version: data.schemaVersion || 1,
            updated_at: new Date().toISOString()
          }];
        }

        state.tables.lab_audit_logs = state.tables.lab_audit_logs || [];
        state.tables.lab_audit_logs.push({
          request_id: requestId,
          action: 'import',
          base_revision: row ? nextRevision - 1 : null,
          resulting_revision: nextRevision,
          created_at: new Date().toISOString()
        });

        return send(200, { revision: nextRevision, beforeSnapshotId: snapshotId, requestId });
      }

      // 備份相關，測試流程不會用到，回一個合理結果
      return send(200, { revision: 1 });
    }

    send(404, { message: 'not found', path });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    // 直接把環境變數設成指向這個假伺服器
    applyEnv(target = process.env, { secret = true } = {}) {
      target.SUPABASE_URL = `http://127.0.0.1:${port}`;
      target.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_key';
      target.SUPABASE_SECRET_KEY = secret ? state.secretKey : '';
      delete target.SUPABASE_ANON_KEY;
      delete target.SUPABASE_SERVICE_ROLE_KEY;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}
