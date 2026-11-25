# 技術交接文件

給接手維護這套系統的人。讀完這份，你應該能：判斷哪裡出問題、安全地改程式、發布新版給各研究室。

---

## 這套系統的定位

一份**範本**，不是一個服務。

```
維護者（你）
  └── 維護這份程式碼（一個 repo）
        └── 研究室甲 → 自己的 Vercel + 自己的 Supabase + 自己的資料
        └── 研究室乙 → 自己的 Vercel + 自己的 Supabase + 自己的資料
        └── 研究室丙 → …
```

每個研究室的資料庫是獨立帳號、獨立專案，你**看不到**他們的資料，也不該看到。
你更新的是程式碼，他們各自拿到新版後自己更新。

這個架構的取捨：

| 好處 | 代價 |
|---|---|
| 資料完全分離，符合研究倫理 | 每個研究室要自己走一次部署流程 |
| 你不需要當資料管理者 | 出了問題你要隔著螢幕判斷 |
| 免費額度各自計算 | 每個研究室都要自己維護一個 Supabase 專案 |

---

## 架構

```
瀏覽器
  │  index.html（單檔前端，原生 JS，約 4700 行）
  │    ├── 第一次設定畫面（setup gate）
  │    ├── 登入（直接打 Supabase Auth，拿 JWT）
  │    └── 主系統（三個頁籤）
  │
  ├──────────────► Supabase Auth（登入）
  │                  回傳 access_token（JWT）
  │
  └──► Vercel Serverless Functions（api/）        ← 帶 JWT
         │  用 secret 金鑰呼叫，繞過 RLS，所以權限自己判斷
         └──► Supabase PostgREST（資料庫）
```

### 為什麼前端直接打 Supabase Auth，卻又要繞回 Vercel

登入由 Supabase 負責（它會處理密碼雜湊、Email 驗證、JWT 簽發）。
但**讀寫資料**要經過 Vercel 的 API，因為：

1. 資料的權限規則比 RLS 能表達的更複雜（例如「只有 admin 能建立備份」）
2. 用 secret 金鑰才能在伺服器端做跨表的操作
3. 前端不需要知道資料表的結構

**重要**：`api/` 用的是 secret 金鑰，它**繞過 RLS**。所以每一支 handler 都必須
自己做權限檢查 —— 不能假設資料庫會擋。這是這個專案最容易出錯的地方。

---

## 檔案地圖

| 路徑 | 作用 | 改動風險 |
|---|---|---|
| `api/_supabase.js` | 金鑰相容層、HTTP 工具、`buildHeaders()` | **高**：改錯會讓所有資料變空 |
| `api/setup.js` | 第一次設定（建立管理員、研究室、初始資料） | **高**：這是安全邊界 |
| `api/setup-status.js` | 診斷端點（wizard 與設定畫面都靠它） | 中 |
| `api/config.js` | 前端啟動設定 | **高**：會送到瀏覽器，絕不能含 secret |
| `api/profiles.js` | 成員管理 | 中：權限在伺服器端判斷 |
| `api/data.js` | 讀寫共用資料（樂觀鎖） | 中 |
| `index.html` | 全部前端 | 中：單檔但要小心全域變數 |
| `supabase/migrations/001` | 主要資料表 | **極高**：已在各研究室跑過，不能改 |
| `supabase/migrations/002` | 研究室設定表 | 高：同上 |
| `wizard/` | 引導式部署網頁 | 低：純前端，壞了也不影響已部署的系統 |
| `scripts/check-project.mjs` | 結構檢查 | 低，但別放寬檢查 |

### 資料庫 migration 不能改

`001` 與 `002` 已經在很多研究室的真實資料庫執行過了。**修改既有檔案對他們沒有作用**
（他們不會重跑），只會讓新舊部署不一致。

要改結構就新增 `003_xxx.sql`，並且在 migration 裡寫成「可以重複執行」的形式
（用 `if not exists`、`drop policy if exists` 再 `create`）。

`002` 開頭有這個檢查，確保它不會在 `001` 之前被執行：

```sql
do $$ begin
  if to_regprocedure('public.current_lab_role()') is null then
    raise exception '請先執行 001_lab_state.sql，再執行本檔。';
  end if;
end $$;
```

---

## 安全設計（改動前必讀）

### 1. 設定鎖：誰能成為第一個管理員

`lab_settings.setup_completed_at` 有值 = 這個部署設定完成了。

- `api/setup.js` 執行前先讀這個欄位，有值就回 `409 already_setup`
- `lab_settings` **刻意沒有 insert 政策**，第一列只能由伺服器用 secret 金鑰建立

**為什麼重要**：Vercel 的網址是公開的。如果允許重複設定，任何先看到網址的人
都能把自己設成管理員，然後把真正的使用者鎖在外面。

**測試**：`tests/integration.test.mjs` 的「情境：設定鎖」會驗證這件事。

### 2. secret 金鑰不能出現在前端

`/api/config` 的回應會被 `index.html` 直接使用。它只回：

- `supabaseUrl`
- `anonKey`（publishable，低權限）
- 研究室名稱、版號、設定完成與否

**絕不要**在這裡加任何 `SUPABASE_SECRET_KEY` 或 service_role 相關欄位。
`tests/unit.test.mjs` 的「describeConfig 不含金鑰值」會擋。

### 3. 新舊金鑰的標頭差異（實測踩過的坑）

```js
// api/_supabase.js 的 buildHeaders()
if (userToken) {
  headers.authorization = `Bearer ${userToken}`;
} else if (!config.newStyleKey) {
  headers.authorization = `Bearer ${config.key}`;   // 舊制必須加
}
```

| 金鑰格式 | 只放 `apikey` | `apikey` + `Authorization` |
|---|---|---|
| 新制 `sb_secret_…` | ✅ 正常 | ❌ 401 `Invalid JWT` |
| 舊制 `eyJ…` JWT | ❌ **200 但回 `[]`** | ✅ 正常 |

第二列是最陰險的：**不會報錯，只會回空陣列**，看起來像「資料庫沒有資料」。
實測：`service_role` 只放 `apikey` 讀 `lab_profiles` 得到 `[]`，
加上 `Authorization: Bearer` 才拿到真正的資料列。

判斷方式：`isNewStyleKey()` 看字首是不是 `sb_publishable_` / `sb_secret_`，
**不是看長度**。

### 4. 沒有固定的預設密碼

建立成員時若呼叫端沒帶密碼，由 `generateTemporaryPassword()` 產生隨機密碼，
只在回應裡回傳一次。

原本的版本寫死了一個固定字串（而且在公開 repo 裡），那等於每個部署都有
同一組公開的萬用密碼。`check-project.mjs` 會檢查這個模式有沒有回來。

### 5. 樂觀鎖

`api/data.js` 寫入時要比對 `revision`。版本不符回 `409 revision_conflict`。
前端收到這個錯誤會自動重新載入並提示「請再按一次儲存」。

---

## 本機開發

```bash
npm run dev    # http://localhost:8080
```

`scripts/dev-server.mjs` 模擬 Vercel 的三件事：

1. `/api/*` 依檔名動態載入 `api/<name>.js`
2. 補上 `res.status()`（Vercel 的 handler 這樣寫，Node 原生沒有）
3. 讀 `.env.local`（與 Vercel 環境變數同名）

要有真實資料庫才能測完整流程：

```bash
cp .env.example .env.local
# 填入 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
npm run dev
```

`.env.local` 在 `.gitignore` 裡。**不要 commit 任何金鑰。**

---

## 測試

```bash
npm run check             # 結構檢查（含「有沒有寫死金鑰」）
npm run test:unit         # 78 項：驗證規則、金鑰樣式、引導網頁的純函式
npm run test:integration  # 32 項：用假資料庫跑完整流程
npm run test:e2e          # 53 項：照瀏覽器實際發的請求打一輪
npm run test:wizard       # 32 項：引導網頁的 7 個步驟與版面
npm run test:ui           # 38 項：headless Chrome 實際載入首頁
npm run test:all          # 全部（233 項）
```

### 建表語法要另外驗（改過 migration 之後必做）

```bash
npm install --no-save @electric-sql/pglite   # 只在驗證時裝，不進版控
npm run verify:sql
```

它會把**引導網頁裡助理實際會貼上的那兩段 SQL** 丟進一個真的 PostgreSQL
（PGlite，編譯成 WebAssembly，不必安裝資料庫）執行，然後確認：

- 兩段語法與 `supabase/migrations/` 逐字相同（樣板字串會把 `$$` 吃成 `$`）
- 真的跑得起來（不是「看起來有內容」而已）
- 六張表都建立、每一張都開了 RLS
- `lab_settings` **沒有** insert 政策（第一列只能由伺服器金鑰建立）
- 八個函式都在，`jsonb_sha256` 算得出 sha256

為什麼要單獨一支：`npm run test:all` 不能依賴額外套件（專案要維持零 npm 依賴），
而「SQL 跑不起來」是**每一個研究室都會卡在同一步**的災難，值得多一道手動關卡。
改過 migration，或改過 `wizard/index.html` 裡內嵌的 SQL 之後，請跑一次。

### 為什麼整合測試用假資料庫

`tests/mock-supabase.mjs` 是記憶體版的 PostgREST + Auth 替身。原因：

1. **設定有鎖**：真資料庫只能成功設定一次，無法重複測試
2. **不能污染**：測試不該寫進任何人的專案
3. **難以重現的狀態**：可以模擬「資料庫被暫停」「資料表還沒建」

它實作了這個專案真的會用到的部分：`on_conflict`、`Prefer: resolution=merge-duplicates`、
`PGRST205`（表不存在）、Auth 的 user CRUD。

### UI 測試測兩種狀態

- **情境 A：全新部署** → 應該看到設定畫面，且「還不能開始」的指引要具體
- **情境 B：設定完成** → 應該看到主系統，研究室名稱要正確套用

情境 A 壞掉的話，助理根本無法開始使用，所以它與情境 B 一樣重要。

---

## 引導網頁（wizard/）

純前端，可以 `file://` 直接打開，不需要伺服器。

它做的事：把「申請 GitHub → 申請 Supabase → 建表 → 部署 Vercel → 填金鑰」
這條路切成 7 步，每步給連結、給可複製的文字、並即時驗證。

### 驗證機制（不用後端）

| 要驗證什麼 | 怎麼驗 |
|---|---|
| Supabase 專案活著 | `GET /auth/v1/health`（帶 `apikey`） |
| 資料表建好了沒 | `GET /rest/v1/lab_state?select=id` |
| Vercel 部署成功 | `GET https://<專案>.vercel.app/api/health` 檢查 `app` 欄位 |

**資料表存在與否的判斷**（實測確認）：

| 情況 | 回應 |
|---|---|
| 表存在、RLS 擋住 | `200 []` |
| 表不存在 | `404 {"code":"PGRST205"}` |
| 金鑰錯 | `401 {"message":"Invalid API key"}` |
| 沒帶金鑰 | `401 {"message":"No API key found in request"}` |

所以「200 但空陣列」代表**建表成功**，不是「沒資料」。

### 為什麼不自動跑 migration

Supabase 的 Management API（`api.supabase.com`）**不回 CORS 標頭**，
瀏覽器無法呼叫。實測：

```
OPTIONS https://api.supabase.com/v1/projects  → 204，但沒有 access-control-allow-origin
```

所以建表只能請使用者自己貼進 SQL Editor。這是目前無解的技術限制，
不是實作偷懶。詳見 `docs/installation.md` 步驟 3。

### 改範本資訊

只改 `wizard/config.js`：

```js
export const TEMPLATE = {
  repoUrl: 'https://github.com/你的帳號/lab-tracker-cloud',
  defaultProjectName: 'lab-tracker',
  ...
};
```

### 引導網頁要放在哪裡

三種都可以，建議第二種：

| 方式 | 怎麼做 | 適合 |
|---|---|---|
| 直接把檔案給助理 | 傳 `wizard/index.html`（它會自己載入同資料夾的 `inline-bundle.js`，所以**兩個檔要一起給**） | 一兩個研究室 |
| 放在範本 repo 的 Pages | 設定 GitHub Pages 指向 `wizard/` | 多個研究室、想給固定網址 |
| 放在任何靜態網站 | 上傳 `wizard/` 兩個檔案 | 你已經有網站 |

**注意**：`index.html` 用相對路徑載入 `inline-bundle.js`。只傳 HTML 過去會
整頁不會動（因為模組載不到），所以兩個檔案必須放在同一個資料夾。
改過 `wizard/wizard.js` 之後要跑 `node wizard/sync-inline.mjs`
重新產生 `inline-bundle.js`，否則 `file://` 開的那份還是舊的
（`npm run check:wizard` 會檢查這件事）。

### 為什麼引導網頁需要 CORS

引導網頁跑在別的網域（可能是 `file://`，也可能是 Pages），
它要打使用者剛部署好的網站的 `/api/health` 與 `/api/setup-status`，
才能告訴助理「你的部署成功了」。

這兩個端點（加上 `/api/config`）在 `api/_supabase.js` 的 `CORS_OPEN_PATHS` 裡
開放 `access-control-allow-origin: *`。它們刻意只回報「設定了沒」，
不含金鑰也不含個人資料，所以開放是安全的。

**需要身分的端點（`data`、`profiles`、`backups`…）不加 CORS** ——
那些用 `Authorization` 帶 JWT，開放等於讓任何網頁代打使用者的帳號。
`tests/e2e.test.mjs` 階段 8 會驗證這個分界。

---

## 發布新版

這個專案**沒有**本機版那種「拖 ZIP 進更新工具」的機制 —— 雲端版的程式碼在
GitHub、資料在 Supabase，兩者本來就分開。更新流程如下。

### 你這邊（維護者）

1. 改程式碼
2. 調整版號：`package.json` 與 `src/lib/app-info.js` 的 `APP_VERSION` 要一致
3. `npm run test:all` 全部通過
4. push 到範本 repo

### 各研究室那邊

| 他們的 GitHub repo 是… | 更新方式 |
|---|---|
| 用 Deploy Button 複製出去的一般 repo | 在 GitHub 頁面按 **Sync fork**，Vercel 會自動重新部署 |
| 自己 fork 的 | `git pull` 之後 Vercel 自動部署，或到 Vercel 按 **Redeploy** |

**他們的資料不會受影響** —— 資料在 Supabase，程式碼更新完全不碰資料庫。

### 最大的維護負擔：migration 不會自動跑

如果你新增了 `003_xxx.sql`，各研究室的資料庫不會自動套用。你必須：

1. 在發布通知裡寫清楚要貼哪一段
2. 同時把那段 SQL 放進 `wizard/index.html` 的
   `<script type="text/plain" class="migration-sql" data-sql-segment>` 區塊
   （一個檔案一段），再跑 `node wizard/sync-inline.mjs`
3. 否則新部署的研究室會拿到舊的建表語法，網站會在第一次設定那關壞掉

`wizard/config.js` 的 `WIZARD.schemaProbeTables` 也要同步更新，
引導網頁第 5 步才知道要驗證哪幾張表。

### 版本號規則

版號有兩個地方，必須一致：

- `package.json` 的 `version`
- `src/lib/app-info.js` 的 `APP_VERSION`

`npm run check` 會驗證。**其他地方不要寫死版號** —— 寫死的話更新後設定頁
會顯示舊版號，維護者就無法判斷研究室真正在跑哪一版。
`check-project.mjs` 的第 7 項檢查會擋。

---

## 排查問題

### 症狀 → 可能原因

| 症狀 | 先查什麼 |
|---|---|
| 網站說「還沒連上資料庫」 | Vercel 環境變數有沒有 `SUPABASE_URL`？補上後有沒有 Redeploy？ |
| 網站說「資料表還沒建立」 | `002` 跑了嗎？`setup-status` 的 `checks.schema.missing` 會說缺哪張 |
| 資料都顯示不出來，但沒報錯 | **金鑰標頭問題**（見上面第 3 點）。用 `describeConfig()` 看 `keyStyle` |
| 免費專案打不開 | Supabase 閒置暫停。去後台按 **Restore project** |
| 設定畫面一直出現 | `setup_completed_at` 沒寫進去。查 `lab_settings` 那一列 |
| 「已設定完成」但沒人設過 | 資料庫曾是別人的？或 `002` 在某處被跑過。查 `lab_settings` |

### 診斷工具

```bash
curl https://你的網址/api/health
curl https://你的網址/api/setup-status
```

`/api/setup-status` 會回：

```json
{
  "backendConfigured": true,
  "setupComplete": false,
  "checks": {
    "environment": { "ok": true },
    "database": { "ok": true, "message": "資料庫連線正常。" },
    "schema": { "ok": false, "missing": ["lab_settings"], "message": "..." }
  }
}
```

它**不會**回傳任何金鑰或個人資料，所以可以安心貼給別人看。

### 使用者說「壞掉了」怎麼問

請他回報這三件：

1. 網址（哪個研究室的）
2. 畫面上寫什麼（截圖最好）
3. `/api/setup-status` 的回應

有這三件，九成的問題可以直接判斷。

---

## 交接清單

交給下一個維護者時，確認以下項目：

- [ ] 範本 repo 的 **admin 權限**已轉移（不要在個人帳號下）
- [ ] `wizard/config.js` 裡的 `repoUrl` 指向正確的 repo
- [ ] 你手上沒有、也不需要任何研究室的 Supabase 金鑰
- [ ] 這份文件與 `docs/installation.md` 都是最新的
- [ ] `npm run test:all` 全綠
- [ ] 知道目前有哪些研究室在用、各自的網址（做一張清單，但**不要**記他們的資料庫密碼）

---

## 已知限制

| 限制 | 原因 | 影響 |
|---|---|---|
| 建表要手動貼 SQL | Supabase Management API 擋 CORS | 部署流程多一個手動步驟 |
| migration 不會自動套用 | 同上 | 發布新版要另外通知 |
| 免費專案閒置一週暫停 | Supabase 免費方案政策 | 寒暑假後要手動 Restore |
| 沒有「忘記密碼」按鈕 | Supabase 預設會寄重設信，但需要設定 SMTP | 目前請維護者在後台重設 |
| 每個研究室要自己一個 Supabase 專案 | 免費方案限 2 個 active 專案 | 同一人管理兩個以上研究室會超額 |
