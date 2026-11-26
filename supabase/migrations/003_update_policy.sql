-- 自動更新的開關：研究室可以在系統介面裡決定「要不要每天自動更新到最新版」。
--
-- 為什麼這件事需要一個資料庫欄位
-- ------------------------------
-- 真正執行更新的是 GitHub Actions（跑在研究室自己的 repo 裡）。它讀不到
-- 我們的資料庫，它只能「問網站」。所以流程是：
--
--   介面上的開關 → 寫進這裡這一欄 → /api/update-policy 讀出來 → Action 去問
--
-- 沒有這一欄，開關就只能存在瀏覽器裡 —— 換一台電腦、換一個瀏覽器就失效，
-- 而且 Action 永遠讀不到。那不是開關，只是個按鈕。
--
-- 為什麼預設是 true（開）
-- ----------------------
-- 自動更新是這個系統的預設行為：研究室部署完之後完全不用管就能拿到修正。
-- 這一欄是「讓不想被自動改動的研究室可以關掉」的逃生門，所以預設維持原本行為。
--
-- 為什麼獨立一個 migration，而不是改 002
-- --------------------------------------
-- 已經部署的研究室早就跑過 002 了，改 002 不會重跑，他們永遠拿不到這一欄。
-- 新開一個檔案，引導網頁就能很清楚地說「還缺第 3 段」。

-- if not exists：讓這段語法重複執行也安全（有人按兩次 RUN 不會爆）。
alter table public.lab_settings
  add column if not exists auto_update_enabled boolean not null default true;

comment on column public.lab_settings.auto_update_enabled is
  '研究室是否允許 GitHub Actions 每天自動同步範本更新。false = 介面上關掉了自動更新。';

-- 既有的那一列（如果已經存在）補上預設值。
-- add column 的 default 對既有資料列本來就會生效，這裡只是明確表達意圖，
-- 同時處理「欄位以前加過、但值是 null」這種半完成狀態。
update public.lab_settings
  set auto_update_enabled = true
  where auto_update_enabled is null;
