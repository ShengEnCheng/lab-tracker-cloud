# 研究室追蹤系統（雲端範本）

給任何研究室使用的多案追蹤與收案示警系統。這是一份**範本**：
每個研究室用它建立一套屬於自己的系統，資料存在自己的資料庫裡。

- 執行環境：Node.js 20 以上，**零 npm 依賴**
- 部署目標：Vercel（免費方案即可）+ Supabase（免費方案即可）
- 適用對象：不熟悉命令列的研究室助理，照著引導網頁按幾步就能完成

---

## 給研究室：怎麼建立自己的系統

**不需要寫任何程式碼。**

1. 打開引導網頁（維護者會給你網址，或直接開 `wizard/index.html`）
2. 照著畫面上的 7 個步驟做：申請 GitHub → 申請 Supabase → 建資料表 → 部署到 Vercel → 填環境變數 → 完成部署 → 建立管理員
3. 每一步都有「一鍵複製」與「即時檢查」，沒過關會告訴你哪裡不對

部署完成後，打開你的網址就會看到「第一次設定」畫面，填研究室名稱與管理員帳密即可開始使用。

完整說明見 [docs/installation.md](docs/installation.md)。

---

## 給維護者：這是什麼、怎麼維護

### 專案結構

```
api/                      Vercel Serveless Functions（每個檔案是一個端點）
  _supabase.js            金鑰相容層與 HTTP 工具（核心）
  config.js               前端啟動設定（絕不回傳 secret 金鑰）
  health.js               健康檢查（引導網頁靠它確認部署成功）
  setup.js                第一次設定：建立管理員、研究室、初始資料
  setup-status.js         診斷：環境／連線／資料表／設定完成度
  data.js                 讀寫共用資料（樂觀鎖）
  profiles.js             成員帳號管理
  import.js               匯入 JSON
  backups.js / backup.js / restore.js   備份
src/lib/                  共用邏輯（前端也用得到）
  app-info.js             版號與名稱（唯一來源）
  initial-state.js        示範資料與空白資料
  setup-validation.js     設定表單的驗證規則
supabase/migrations/      資料庫建表語法（依序執行 001、002）
wizard/                   引導式部署網頁
scripts/dev-server.mjs    本機開發伺服器（模擬 Vercel）
scripts/check-project.mjs 專案結構檢查
tests/                    單元、整合、UI 測試
docs/                     安裝指南與交接文件
```

### 開發

```bash
npm run dev          # 本機啟動（http://localhost:8080）
npm run check        # 專案結構檢查
npm run test:all     # 全部測試（421 項）

# 改過 migration 或引導網頁裡的 SQL 之後，另外跑這個：
npm install --no-save @electric-sql/pglite
npm run verify:sql   # 把 SQL 丟進真 PostgreSQL 執行，確認建得起來
```

本機測試要連真的資料庫時，複製 `.env.example` 為 `.env.local` 並填入 Supabase 設定。
`.env.local` 已在 `.gitignore` 裡，不會進版控。

### 金鑰的兩種格式（重要）

Supabase 正在汰換舊金鑰，兩種都要支援：

| | 舊制 | 新制 |
|---|---|---|
| 前端（低權限） | `anon`（`eyJ…` JWT） | `publishable`（`sb_publishable_…`） |
| 伺服器（高權限） | `service_role`（`eyJ…` JWT） | `secret`（`sb_secret_…`） |

環境變數名稱兩種都接受：

- 前端：`SUPABASE_PUBLISHABLE_KEY` 或 `SUPABASE_ANON_KEY`
- 伺服器：`SUPABASE_SECRET_KEY` 或 `SUPABASE_SERVICE_ROLE_KEY`

**有一個實測踩到的坑**：舊制金鑰必須同時放進 `apikey` 與 `Authorization: Bearer` 兩個標頭，
否則 PostgREST 會把它當匿名請求，RLS 全部擋掉 —— 回應是 HTTP 200 但內容是 `[]`，
不會報錯，非常容易誤判成「資料庫是空的」。新制金鑰則相反，放進 `Authorization` 會被
當成 JWT 解析而回 401。這段邏輯在 `api/_supabase.js` 的 `buildHeaders()`，改動前請先看註解。

### 修改研究室看到的外觀

研究室名稱、代碼、品牌字都在**第一次設定**時由使用者自己填，程式碼裡沒有寫死任何名字。
要改引導網頁的範本資訊（repo 網址、預設專案名稱），改 `wizard/config.js` 一個檔案。

### 發布新版給各研究室

改完程式碼後：

1. 調整 `package.json` 與 `src/lib/app-info.js` 的版號（`npm run check` 會驗證兩者一致）
2. `npm run test:all` 全部通過
3. push 到範本 repo
4. 通知各研究室在自己的 GitHub repo 按 **Sync fork**（或 pull），Vercel 會自動重新部署

**資料不會受影響**，因為資料在 Supabase，不在程式碼裡。研究室更新的是程式碼，
他們的資料庫完全沒被碰到。

**但 migration 不會自動跑。** 如果你新增了 `003_xxx.sql`，要在通知裡寫清楚
「請到 Supabase 的 SQL Editor 貼上這段」，並把語法放在 `wizard/` 的內嵌 SQL 區塊裡。
這是目前最大的維護負擔。

---

## 安全設計

| 設計 | 為什麼 |
|---|---|
| 設定完成後不能再設定第二次 | 公開網址的網站若允許重複設定，先看到網址的人就能取得管理員權限 |
| `lab_settings` 沒有 insert 政策 | 第一列只能由伺服器用 secret 金鑰建立，不能由匿名請求建立 |
| 建立成員時沒帶密碼就隨機產生 | 固定預設密碼等於每個部署都有同一組公開的萬用密碼 |
| `/api/config` 只回前端金鑰 | 它會送到瀏覽器，secret 金鑰絕不能出現在裡面 |
| 寫入使用樂觀鎖 | 兩人同時編輯時，後者會被擋下並提示重新載入，不會靜默覆蓋 |

`npm run check` 會自動檢查「有沒有寫死別人的 Supabase 網址或金鑰」「有沒有寫死的預設密碼」
「secret 金鑰有沒有外洩」，這幾項一旦漏掉，複製出去的研究室會連到別人的資料庫。

---

## 文件

- [docs/installation.md](docs/installation.md) — 給研究室的完整部署步驟
- [docs/handover.md](docs/handover.md) — 給接手維護者的技術說明
