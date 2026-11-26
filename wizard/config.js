// ============================================================================
// config.js — 範本設定常數
//
// 維護者只需要改這個檔案。改完之後，`index.html` 開起來就會用新的值。
// （若你要讓「雙擊 file:// 開啟」的模式也同步，請看 index.html 開頭的
//   「同步內嵌副本」說明，或執行 `node wizard/sync-inline.mjs`。）
// ============================================================================

export const TEMPLATE = {
  // 範本程式碼所在的公開 repo（維護者改成自己的）。
  //
  // 這個 repo 必須真的存在、而且是公開的，否則第 4 步的「一鍵部署」會失敗：
  // Vercel 去 GitHub 找不到這個 repo，助理會看到一句看不懂的錯誤。
  //
  // 上線前請確認：
  //   1. 這個 repo 已經建好並 push 上去
  //   2. 它是 public（private 的 repo 不能給別人複製）
  //   3. 打開 https://github.com/<你的帳號>/lab-tracker-cloud 看得到內容
  //
  // `npm run check` 會檢查這一行：格式不對是錯誤，還留著預設值則是提醒。
  repoUrl: 'https://github.com/ShengEnCheng/lab-tracker-cloud',
  // Supabase 官方的 Vercel 整合 ID。留著只是為了「使用者想走官方整合」時
  // 還能當備案；預設流程**不再使用它**（原因見下面 requiredEnvVars 的說明）。
  supabaseIntegrationId: 'oac_VqOgBHqhEoFTPzGkPd7L0iH6',

  // 網站執行時需要的環境變數。順序就是「一鍵部署」表單上出現的順序。
  //
  // 為什麼是這三個、而且一個都不能少：
  //   SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY → 網站要連資料庫
  //   SUPABASE_SECRET_KEY → 建立第一個管理員帳號時要寫入受保護的資料表
  //     （api/setup.js 的 handleStatus/handleSetup 都用 supabaseConfig(true)，
  //      少了它，網站連得動資料庫但「第一次設定」那一步會直接壞掉，
  //      而且畫面只會說「還沒連上資料庫」——完全指錯方向。）
  //
  // 這三個值都只有使用者自己拿得到，所以引導網頁的工作是「陪他去 Supabase
  // 後台把值抄回來、幫他貼進部署表單」，而不是假裝能幫他查。
  requiredEnvVars: ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'],
  // 部署後的預設專案名稱
  defaultProjectName: 'lab-tracker',
  appDisplayName: '研究室追蹤系統'
};

// ---------------------------------------------------------------------------
// 進階設定：一般情況不需要動。
// ---------------------------------------------------------------------------

export const WIZARD = {
  // 每一個網路請求最多等幾毫秒。超過就當作「網路太慢或不通」。
  requestTimeoutMs: 12000,

  // 步驟 4 要探測的資料表名稱。這個資料表存在，代表建表語法跑過了。
  // 對應 supabase/migrations/001_lab_state.sql 裡的 public.lab_state。
  // （interpretSchemaProbe 的預設值就是這一個。）
  schemaProbeTable: 'lab_state',

  // 步驟 4 驗證時「依序」要確認存在的資料表，一段語法對一張。
  // 為什麼不只驗 lab_state：建表語法分成三段（001、002、003），
  // 只跑第 1 段的人 lab_state 會存在、但少了 lab_settings，
  // 網站會在「第一次使用」那關壞掉。所以要全部都問。
  schemaProbeTables: ['lab_state', 'lab_settings'],

  // 第 3 段（003）沒有新增資料表，只在既有的 lab_settings 上加一個欄位。
  // 「表在不在」永遠問不出它有沒有跑過，所以另外問這個欄位。
  // 漏跑的使用者症狀：系統完全正常，只有「系統設定」的自動更新開關按不動。
  // 那種壞法沒有錯誤訊息，最難查 —— 所以在驗證這一步就抓出來。
  schemaProbeColumns: [
    { table: 'lab_settings', column: 'auto_update_enabled', label: '第 3 段（003）' }
  ],

  // 步驟 2 驗證 /api/health 時，可接受的系統名稱。
  // 現行的 api/health.js 回 { app: 'lab-tracker-cloud', … }（來自 src/lib/app-info.js）。
  // 為什麼還留著 'zheng-lab-api'：早期版本的 health 端點回的是這個名字，
  // 有人可能部署到舊版本。兩種都當作「打對了」，
  // 免得使用者明明部署成功卻被電腦說失敗。
  acceptedServiceNames: ['lab-tracker-cloud', 'zheng-lab-api'],

  // Supabase 建議區域（免費方案也要選對，離台灣最近的是 Singapore）。
  supabaseRegionLabel: 'Singapore（新加坡，代號 ap-southeast-1）',

  // 顯示在畫面上的「有問題找誰」。
  supportContact: '請找當初協助研究室建置這套系統的資訊人員，或研究室主持人。',

  // 免費方案的金鑰提示：只有這一把會出現在網頁裡；真正不能外流的是 secret key。
  publishableKeyPrefix: 'sb_publishable_'
};
