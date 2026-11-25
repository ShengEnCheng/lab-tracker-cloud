-- 研究室基本設定：組織名稱、代碼、聯絡信箱、設定完成時間。
--
-- 為什麼要獨立一張表，而不是塞進 lab_state：
--   登入畫面在「還沒登入」時就要知道研究室叫什麼名字（讓助理確認自己開對網站），
--   但 lab_state 受 RLS 保護，未登入的人依權限規則讀不到任何一列。
--   這張表只存非敏感的顯示設定，並透過 /api/config 以白名單欄位對外提供。
--
-- 注意：本檔必須在 001_lab_state.sql 之後執行（需用到 current_lab_role()）。

do $$ begin
  if to_regprocedure('public.current_lab_role()') is null then
    raise exception '請先執行 001_lab_state.sql，再執行本檔。';
  end if;
end $$;

create table if not exists public.lab_settings (
  id integer primary key check (id = 1),
  organization_name text not null default '',
  organization_code text not null default '',
  contact_email text not null default '',
  setup_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lab_settings enable row level security;

drop policy if exists "admins can read settings" on public.lab_settings;
create policy "admins can read settings"
on public.lab_settings for select
using (public.current_lab_role() in ('admin', 'backup_admin'));

drop policy if exists "admins can update settings" on public.lab_settings;
create policy "admins can update settings"
on public.lab_settings for update
using (public.current_lab_role() in ('admin', 'backup_admin'))
with check (public.current_lab_role() in ('admin', 'backup_admin'));

-- 刻意沒有 insert 政策：第一列只能由伺服器用 secret 金鑰建立（見 api/setup.js）。
-- 這樣「誰能成為第一個管理員」就由伺服器端「這個部署設定過了沒」判斷，
-- 而不是由任何匿名請求決定。
