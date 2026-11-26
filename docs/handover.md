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
npm run check             # 結構檢查（含「有沒有寫死金鑰」、repo 讀不讀得到）
npm run test:unit         # 83 項：驗證規則、金鑰樣式、引導網頁的純函式
npm run test:integration  # 32 項：用假資料庫跑完整流程
npm run test:e2e          # 53 項：照瀏覽器實際發的請求打一輪
npm run test:session      # 27 項：設定完成後登入、讀寫、版本衝突
npm run test:handoff      # 24 項：DEMO 的資料匯出後能不能匯入新系統
npm run test:roster       # 11 項：成員名冊不能被外來備份蓋掉、孤兒負責人
npm run test:export       # 16 項：匯出檔裡每一個欄位都在、一個都沒被改
npm run test:import       # 32 項：使用者真的上傳一份匯出檔，能不能匯進新系統
npm run test:import-ui    # 20 項：用瀏覽器按「⭱ 匯入」選那份檔案，整條路走一遍
npm run test:update       # 17 項：研究室部署好之後，維護者怎麼幫他們更新
npm run test:auto-update  # 22 項：自動更新真的會跑嗎、會不會默默失效
npm run test:update-policy # 24 項：研究室在介面上關掉自動更新，真的會停下來嗎
npm run test:settings-ui  # 51 項：那顆開關在畫面上真的看得到、按得動、失敗會撥回去
npm run test:checkup      # 33 項：使用者每天要做的事，逐一真的做一遍
npm run test:wizard       # 32 項：引導網頁的 7 個步驟與版面
npm run test:journey      # 45 項：引導網頁從第 1 步真的走到第 7 步
npm run test:ui           # 38 項：headless Chrome 實際載入首頁
npm run test:all          # 全部（567 項）
```

### 十三支測試各負責哪一段

這套產品的路很長，切成十三段來測，任一段壞掉都不會被別段掩蓋：

| 測試 | 涵蓋的路 |
|---|---|
| `test:e2e` | 部署完成 → 第一次設定 → 資料真的寫進資料庫 |
| `test:session` | **設定完成之後的日常使用**：登入、讀資料、存資料、兩人同時改 |
| `test:handoff` | **DEMO 退役**：舊系統匯出的檔案，匯入新系統後資料一字不差 |
| `test:roster` | **成員名冊的來源**：匯入外來備份後，名冊仍以真正的登入帳號為準；孤兒負責人認得出來 |
| `test:export` | **資料完整導出**：每一種資料的每一個欄位，匯出後都還在、都沒被改 |
| `test:import` | **收得下來**：拿一份真的匯出檔 POST 進新系統，資料與名冊都對 |
| `test:import-ui` | **畫面上真的能按**：用瀏覽器把檔案塞進「⭱ 匯入」，走完確認與快照 |
| `test:update` | **交付之後的維護**：研究室怎麼更新、為什麼不能用 merge、更新不會碰資料 |
| `test:auto-update` | **自動更新不會默默死掉**：作者身分、心跳 commit、備份分支、範本自己不會被 reset |
| `test:update-policy` | **介面上的開關真的有用**：關掉時一個檔案都不動、查不到網站時放行、決定存在資料庫 |
| `test:settings-ui` | **那顆開關本身**：管理員看得到、按得動、失敗會撥回去；研究人員看不到也按不動 |
| `test:checkup` | **每天要做的事**：新增成員、打勾、切頁籤、看月曆、匯出，逐一真的做一遍 |
| `test:journey` | 助理在引導網頁上從第 1 步按到第 7 步，每步驗證都要通過 |

`test:session` 特別重要：它是唯一會驗「兩個人同時改同一份資料」的地方。
先送的人成功、後送的人被擋下（409），而且**被擋下的那次不能偷偷覆蓋別人的資料**。
這是研究室多人使用時每天都會遇到的情況。

`test:update` 守的是「這份文件寫的步驟是真的做得到的」。它用真 git 重建一個
「研究室用一鍵部署拿到的副本」，然後實際去 merge 一次，記下衝突的長相 ——
因為文件原本寫的更新方式（按「Sync fork」）**根本做不出來**：一鍵部署是
複製一份新 repo，不是 fork，那個按鈕不會出現。所以這支測試驗的是
「文件只能寫驗證過的做法」，不是「文件寫得漂亮」。

`test:auto-update` 守的是**三個在畫面上完全看不出來的死法**。自動更新如果壞了，
網站只會「停在舊版」——沒有錯誤訊息、沒有紅字、沒有任何通知，而且很可能要等到
某個功能壞掉才會有人發現。它驗的三件事都是這一類：

- 自動更新的 commit 作者若是 bot，Vercel 會默默擋掉部署（作者必須是團隊成員）
- 研究室 60 天沒活動，GitHub 會默默停用排程（所以要有心跳 commit）
- `.github/` 若被同步覆蓋，排程會把自己刪掉（所以更新只發生一次）

這三項的變異測試都有效：故意改壞任何一項，測試就會紅。

`test:update-policy` 守的是「使用者按了按鈕，系統真的照做」。這個功能的
失敗方式是**最惡劣的一種**：研究室在介面上按了「關閉自動更新」、畫面顯示
「已關閉」、一切看起來正常，但系統隔天照樣被改掉 —— 使用者不會收到任何
錯誤訊息，只會在某天發現系統「自己變了」，而那正是他按那顆按鈕想避免的事。
反過來也一樣糟：如果把「讀不到」當成「關掉了」，所有研究室會在某次網路抖動
後永久停止更新，畫面上同樣看不出來。所以這支測試驗四個方向：

- 關掉時，更新腳本**一個檔案的 mtime 都不能變**（不是「有 exit 0 就好」）
- 開著時更新照常發生（不能因為加了檢查就壞掉）
- 查不到網站時**放行**，不是停止（既有研究室都沒設 `LAB_SITE_URL`）
- 這個決定存在資料庫，不是只存在某個人的瀏覽器裡

「資料庫連不上」有兩條不同的程式路徑（回 503 與 fetch 直接丟錯），
兩條都要驗 —— 只驗一條的話，另一條可能默默變成「關掉」。

`test:settings-ui` 補的是上一支測試看不到的那一半：上面驗的是「資料庫與腳本」，
但使用者只看到畫面。這支用真的 Chrome 開 `index.html`，以管理員身分打開
「⚙️ 系統設定」，把開關撥過去，確認四件事：真的送出 PATCH（不是只改畫面）、
開關停在他撥的位置、畫面的文字和開關一致、**存不進去時開關會撥回去**。

最後那項看起來很細，但它是一種很傷的假成功：使用者按了「關閉」、畫面顯示
「已關閉」，他很滿意地關掉視窗 —— 但資料庫其實沒寫進去，系統明天照樣自己
更新。他不會知道，直到某天發現系統變了。變異測試驗證過：把「失敗時撥回去」
拿掉，測試會紅。

同一支也驗「研究人員看不到按鈕，就算硬打開也是停用的」—— 權限不只在後端擋。

`test:export` 守的是使用者最後的保命手段。匯出看起來只是 `JSON.stringify`，
但只要有一個欄位沒被寫進去，那個欄位就是**永久消失，而且不會有任何錯誤訊息**。
所以它造一份「每個欄位都填了可辨識值」的資料，用頁面真正的匯出函式跑一遍，
再逐欄位比對，並指出缺少的路徑（例如 `$.music40[0].quiz3Done`）。
這支測試做過變異測試：故意讓匯出漏掉欄位，它確實會抓到並說出是哪一個。

`test:import` 與 `test:import-ui` 是同一件事的兩層。前者走 HTTP（直接打 `/api/import`），
適合驗權限、幂等、壞格式；後者才是使用者真正會做的事——**在畫面上按按鈕選檔案**。
中間還隔著頁面自己的檢查（`validateImportedData`）、摘要對話框、匯入前快照，
任何一層出錯使用者都會卡住，而 HTTP 層的測試完全看不到。所以兩支都要有。

`test:import-ui` 用的檔案不是隨手捏的測資，而是**從現在的線上系統真的按下匯出得到的那一份**。
使用者的問題是「這份能不能匯入」，所以就拿那一份去驗，不重新造一份看起來像的。

`test:checkup` 回答的是另一個問題：「我把系統交給助理，他每天要做的事真的都做得成嗎」。
它用真的瀏覽器開頁面，像使用者一樣新增成員、打勾、切頁籤、匯出，然後**驗資料真的被改對**，
而不只是「按了沒報錯」。

`test:handoff` 與 `test:roster` 是一組的，處理「先用一套試，之後搬家」這個情境：
資料本身跟著匯出檔走，**成員名冊不跟**——能不能登入是由 Auth 帳號決定的，
資料檔裡的字串再怎麼寫都不會讓人多一個帳號。所以匯入後名冊必須校正回
真正的帳號清單，否則畫面會顯示根本登不進來的人。

### 建表語法要另外驗（改過 migration 之後必做）

```bash
npm install --no-save @electric-sql/pglite   # 只在驗證時裝，不進版控
npm run verify:sql
```

它會把**引導網頁裡助理實際會貼上的那幾段 SQL** 丟進一個真的 PostgreSQL
（PGlite，編譯成 WebAssembly，不必安裝資料庫）執行，然後確認：

- 每一段語法都與 `supabase/migrations/` 逐字相同（樣板字串會把 `$$` 吃成 `$`）
- 每一段重跑一次也不會報錯（助理很可能不確定跑過沒就再貼一次）
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
GitHub、資料在 Supabase，兩者本來就分開。

### 先搞清楚：一鍵部署是「複製」，不是 fork

這件事決定了更新方式，所以先講清楚。研究室的 GitHub repo 是 Vercel 用
`repository-url` **複製一份新 repo**（clone）到他們帳號底下建的，不是 fork：

| | fork | 一鍵部署（clone） |
|---|---|---|
| 跟範本有血緣關係 | 有 | **沒有**（兩邊沒有共同祖先） |
| GitHub 有「Sync fork」按鈕 | 有 | **沒有這個按鈕** |
| 更新方式 | 按 Sync fork | 見下面的四行指令 |

所以**不要教研究室按「Sync fork」** —— 那個按鈕在他們的 repo 上不會出現。
`tests/update-path.test.mjs` 會實際建一個「一鍵部署副本」來驗證這件事。

### 你這邊（維護者）

1. 改程式碼
2. 調整版號：`package.json` 與 `src/lib/app-info.js` 的 `APP_VERSION` 要一致
3. `npm run test:all` 全部通過
4. push 到範本 repo

### 預設做法：自動更新，研究室完全不用動手

這是目前的做法。研究室什麼都不用做 —— 他們的 repo 每天自己去範本拉更新。

運作方式：

```
.github/workflows/template-sync.yml   每天 UTC 20:00（台灣清晨 4:00）跑一次
        │
        └─ bash scripts/apply-template-update.sh
             ├─ 比版號：範本比現在新才動作
             ├─ 保留 .github/（否則排程會把自己刪掉）
             ├─ reset 到範本的最新版
             ├─ 用研究室自己的身分 commit
             └─ push 回自己的 repo → Vercel 自動重新部署
```

這兩個檔案一鍵部署時就跟著複製到研究室，所以**不需要他們做任何設定**。

### 研究室想關掉自動更新時（介面上的開關）

自動更新預設是開的，但有些研究室會想自己控制更新時間（例如計畫進行中不想
改動系統）。**他們不需要碰 git，也不用找維護者** —— 系統裡就有一個開關：

系統右上角 **⚙️ 系統設定** → **自動更新** → 關掉。

這個開關只有管理員看得到、按得動。資料存在 `lab_settings.auto_update_enabled`，
不在瀏覽器裡，所以換電腦、換瀏覽器都還是關著的。

**它是怎麼生效的**（這是整個設計的關鍵）：

```
研究室在介面上按「關閉」
      ↓ PATCH /api/update-policy
資料庫 lab_settings.auto_update_enabled = false
      ↓ GET /api/update-policy（公開可讀，不需要登入）
研究室的 GitHub Action 每天執行前先問一句：這間研究室關掉了嗎？
      ↓ 是
腳本印出「已在介面上關閉自動更新」然後一個檔案都不動
```

Action 是 GitHub 的機器在跑，它沒有研究室的帳號密碼，所以那支查詢端點
必須是公開的。它只回一個布林值（和網站自己的網址），沒有成員名單、
沒有任何金鑰 —— 被不相干的人看到也沒有用。

**開關要生效，研究室要填一個 GitHub 變數**：

| 位置 | 名字 | 值 |
| --- | --- | --- |
| repo → Settings → Secrets and variables → Actions → **Variables** | `LAB_SITE_URL` | `https://他們的網址` |

引導網頁第 7 步有寫這段，會自動帶入他們自己的網址。

> **沒填也不會壞。** 腳本查不到網站網址時會**照常更新**（維持原本行為）。
> 這是刻意的取捨：既有的研究室是在這一版之前部署的，都沒有這個變數。
> 如果「查不到」被當成「關掉了」，他們會在完全沒有感覺的情況下永久停止
> 收到修正，而且畫面上不會有任何提示。寧可多更新一次（更新不碰資料），
> 也不要靜默地停掉所有更新。
>
> `tests/auto-update-policy.test.mjs` 有專門驗這一條：把網站指向一個沒有人
> 在聽的 port，更新必須照常發生。

**漏跑第 3 段 SQL 會怎樣**：資料表都建好了，系統其他部分完全正常 ——
只有這個開關按不動。所以引導網頁第 5 步的驗證會去問
`lab_settings.auto_update_enabled` 這個欄位在不在，不在就明確講
「還缺第 3 段（003）」。`api/setup-status.js` 也有一樣的檢查。

同步邏輯刻意放在 `scripts/apply-template-update.sh` 而不是寫進 workflow YAML，
是因為 GitHub 的 `GITHUB_TOKEN` **不能修改 `.github/workflows/` 底下的檔案**
（安全限制，任何 `permissions` 都無法解開）。邏輯放腳本、YAML 只負責呼叫，
以後改同步方式就不必動 workflow 檔。`tests/auto-update.test.mjs` 會驗證這件事。

有三個地方不做的話會**默默壞掉，而且畫面上完全看不出來** ——

**① commit 作者要是研究室的人，不能是 bot。**
Vercel 的原生 Git 整合在建立部署前會檢查 commit 作者是不是團隊成員，
不是就直接擋掉整筆部署，而且不會出現任何錯誤訊息。所以腳本沿用這個 repo
**第一個 commit 的作者**（也就是當初按一鍵部署的那個人，一定是有權限的成員），
不是固定的 bot 信箱。用 bot 的話網站會永遠停在舊版，而且查不出原因。

**② 每 45 天要留一個心跳 commit。**
GitHub 會在使用者「60 天沒有活動」後自動停用排程 workflow，同樣不通知
（[GitHub 文件](https://docs.github.com/actions/using-workflows/disabling-and-enabling-a-workflow)：
「In a public repository, scheduled workflows are automatically disabled when no
repository activity has occurred in 60 days.」）。研究室平常不會 commit，
所以腳本會在距上次 commit 超過 45 天時發一個空的 commit 把計時器歸零。

**③ 更新前要留備份分支。**
`reset --hard` 是不可逆的。腳本每次更新前會把舊的 HEAD 推到
`pre-update-backup` 分支（固定名稱，所以永遠只有一條），研究室發現新版有問題時
可以退回去：

```bash
git reset --hard origin/pre-update-backup && git push --force origin main
```

維護者要確認某間研究室的自動更新有沒有在跑，看兩個地方：

```bash
curl https://他們的網址/api/health            # 看 version 有沒有跟上
```

或到他們 repo 的 **Actions** 分頁看「自動更新」這個 workflow 的執行紀錄。
如果顯示 `disabled_inactivity`，就是 60 天沒活動被停用 —— 到 Actions 分頁按
「Enable workflow」，或 `gh workflow enable template-sync.yml` 即可。

> 這個機制只保證「程式碼跟上範本」。**資料庫的 migration 仍然要另外處理**，
> 見下面「最大的維護負擔」那一節。

### 手動更新（自動更新失效時的備援）

研究室**不需要**、也**不應該**自己改程式碼。他們要調的東西（研究室名稱、
成員、方案、追蹤時間點）都在資料庫與 `lab_settings`，不在程式碼裡。

如果自動更新因為某些原因沒跑（例如 60 天沒活動被停用），研究室（或他們的
工程師）可以在自己電腦上手動跑：

```bash
cd lab-tracker                      # 他們自己的那份
git remote add upstream https://github.com/ShengEnCheng/lab-tracker-cloud.git
git fetch upstream
git reset --hard upstream/main      # 程式碼變成最新版
git push --force origin main        # 推回自己的 repo
```

推回去之後 Vercel 會自動重新部署（約 1～2 分鐘）。

**為什麼用 `reset --hard` 而不是 `merge` / `pull`**：兩邊沒有共同祖先，git
沒辦法判斷「誰改了哪一行」，只能整個檔案對整個檔案比 —— 只要檔案內容不同就
產生 `add/add` 衝突（實測：版本差 5 個 commit 時，`index.html`、`README.md`、
`api/setup.js`… 全部衝突）。那是非技術人員處理不來的。`reset --hard` 沒有這個
問題，結果也確定（程式碼跟範本一模一樣）。

**代價**：如果研究室自己動手改過程式碼，那些修改會被蓋掉。所以文件要跟他們
講明白：要調東西請走環境變數、資料庫、或回報維護者，不要直接改程式碼。

**他們的資料不會受影響** —— 資料在 Supabase，程式碼更新完全不碰資料庫。
研究室的 Supabase 網址與金鑰放在 Vercel 的環境變數，也不在 repo 裡，
所以 `reset --hard` 不會讓他們連到錯的資料庫。
`tests/update-path.test.mjs` 會驗證「版控裡沒有 `.env`」「前端沒有寫死 Supabase 網址」。

### 查某個研究室實際在跑哪一版

```bash
curl https://他們的網址/api/health
```

看回應裡的 `version`。這支端點不需要登入、也不碰資料庫（資料庫睡著時仍查得到），
所以適合拿來確認「這個研究室到底更新了沒」。

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

`npm run check` 會驗證。**其他地方不要寫死版號** —— 寫死的話更新後
`/api/health` 會回舊版號，維護者就無法判斷研究室真正在跑哪一版。
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

**上線前一定要做的（沒做就不能用）**

- [ ] **範本 repo 已建立並 push，而且是 public**
      引導網頁第 3 步的「一鍵部署」會叫 Vercel 去這個 repo 複製程式碼。
      repo 不存在或不是 public，助理按下去只會看到一句看不懂的錯誤。
      確認方式：用「沒有登入 GitHub」的瀏覽器打開
      `https://github.com/<你的帳號>/lab-tracker-cloud`，看得到內容才算數。
- [ ] `wizard/config.js` 的 `repoUrl` 改成上面那個 repo
      （`npm run check` 會提醒你：還留著預設值就代表還沒改）
- [ ] 範本 repo 的 **admin 權限**已轉移（不要留在個人帳號下，人一離職就麻煩）
- [ ] 引導網頁有地方可以給助理開：把 `wizard/` 整個資料夾給他們，
      或放到任何靜態網站（`index.html` 和 `inline-bundle.js` **必須同一個資料夾**）

**每次改程式碼之後**

- [ ] `npm run test:all` 全綠（567 項）
- [ ] 改過 `wizard/wizard.js` 就 `node wizard/sync-inline.mjs`
      （忘了跑，雙擊開啟的那份引導頁會是舊的；`npm run check:wizard` 會擋）
- [ ] 改過 `supabase/migrations/*.sql` 就同步更新 `wizard/index.html` 裡內嵌的那幾段
      （`node wizard/sync-inline.mjs --check` 會逐字比對，也會驗證 `$$` 沒有被吃掉）
- [ ] 改過 SQL 之後另外跑一次 `npm run verify:sql`
      （要先用 `npm install --no-save @electric-sql/pglite`；它會把 SQL 丟進真的
      PostgreSQL 跑一次，確認每一張研究室都會貼的那段語法沒有壞）

**交接時**

- [ ] 你手上沒有、也不需要任何研究室的 Supabase 金鑰
- [ ] 這份文件與 `docs/installation.md` 都是最新的
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
