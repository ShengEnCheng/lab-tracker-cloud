-- 研究室追蹤系統：第 4 段 —— 權限檢查修正（安全性更新）
--
-- 修正的問題：
--   1. 「current_lab_role() not in ('admin', 'backup_admin')」在角色是 NULL 時不成立
--      （SQL 的 NULL not in (...) 結果是 NULL，不是 true），所以沒有角色的人
--      —— 被停用的成員、或自己去 Supabase 註冊的帳號 —— 反而不會被擋下，
--      可以清光備份（prune_lab_backups）、覆蓋全部資料（import_lab_state）、
--      還原任意備份（restore_lab_backup）。
--   2. create_lab_backup 沒有收回預設的執行權限，未登入的人也能呼叫。
--
-- 這一段可以重複執行，貼兩次也不會壞。已經在用的研究室只要補貼這一段即可，資料不受影響。

-- 「呼叫者是不是管理員」：角色是 NULL 時明確回 false。
create or replace function public.is_lab_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.current_lab_role()::text, '') in ('admin', 'backup_admin');
$$;

create or replace function public.prune_lab_backups(p_daily_keep integer default 30, p_weekly_keep integer default 12)
returns integer
language plpgsql security definer set search_path = public
as $$
declare deleted_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_lab_admin() then
    raise exception 'not_authorized';
  end if;
  with keep_daily as (
    select id from public.lab_backups where kind = 'scheduled' order by created_at desc limit greatest(p_daily_keep, 0)
  ), keep_weekly as (
    select id from public.lab_backups where kind = 'weekly' order by created_at desc limit greatest(p_weekly_keep, 0)
  ), doomed as (
    select id from public.lab_backups where kind = 'scheduled' and id not in (select id from keep_daily)
    union all
    select id from public.lab_backups where kind = 'weekly' and id not in (select id from keep_weekly)
  )
  delete from public.lab_backups where id in (select id from doomed);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.import_lab_state(
  p_data jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  current_row public.lab_state%rowtype;
  snapshot_id uuid;
  next_revision bigint;
  actor uuid := auth.uid();
  existing_log public.lab_audit_logs%rowtype;
begin
  if not public.is_lab_admin() then
    raise exception 'not_authorized';
  end if;
  select * into existing_log from public.lab_audit_logs where request_id = p_request_id;
  if existing_log.id is not null then
    return jsonb_build_object('revision', existing_log.resulting_revision, 'requestId', p_request_id, 'idempotent', true);
  end if;
  select * into current_row from public.lab_state where id = 1 for update;
  if current_row.id is not null then
    insert into public.lab_backups(source_revision, schema_version, data, checksum, created_by, kind)
    values (current_row.revision, current_row.schema_version, current_row.data, public.jsonb_sha256(current_row.data), actor, 'before_import')
    returning id into snapshot_id;
    next_revision := current_row.revision + 1;
    update public.lab_state set data = p_data, revision = next_revision,
      schema_version = coalesce((p_data->>'schemaVersion')::integer, current_row.schema_version),
      updated_at = now(), updated_by = actor where id = 1;
  else
    next_revision := 1;
    insert into public.lab_state(id, data, revision, schema_version, updated_by)
    values (1, p_data, next_revision, coalesce((p_data->>'schemaVersion')::integer, 1), actor);
  end if;
  insert into public.lab_audit_logs(request_id, action, base_revision, resulting_revision, actor_id, entity_summary)
  values (p_request_id, 'import', current_row.revision, next_revision, actor,
          jsonb_build_object('beforeSnapshotId', snapshot_id));
  return jsonb_build_object('revision', next_revision, 'beforeSnapshotId', snapshot_id, 'requestId', p_request_id, 'updatedAt', now());
end;
$$;

create or replace function public.restore_lab_backup(
  p_backup_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  backup_row public.lab_backups%rowtype;
  current_row public.lab_state%rowtype;
  next_revision bigint;
  before_restore_id uuid;
  actor uuid := auth.uid();
  existing_log public.lab_audit_logs%rowtype;
begin
  if not public.is_lab_admin() then
    raise exception 'not_authorized';
  end if;
  select * into existing_log from public.lab_audit_logs where request_id = p_request_id;
  if existing_log.id is not null then
    return jsonb_build_object('revision', existing_log.resulting_revision, 'requestId', p_request_id, 'idempotent', true);
  end if;

  select * into backup_row from public.lab_backups where id = p_backup_id;
  if backup_row.id is null then raise exception 'backup_not_found'; end if;
  if backup_row.checksum is not null and backup_row.checksum <> public.jsonb_sha256(backup_row.data) then
    raise exception 'backup_integrity_failed';
  end if;

  select * into current_row from public.lab_state where id = 1 for update;
  if current_row.id is not null then
    insert into public.lab_backups(source_revision, schema_version, data, checksum, created_by, kind)
    values (current_row.revision, current_row.schema_version, current_row.data, public.jsonb_sha256(current_row.data), actor, 'before_restore')
    returning id into before_restore_id;
  end if;
  next_revision := coalesce(current_row.revision, 0) + 1;
  update public.lab_state
     set data = backup_row.data,
         revision = next_revision,
         schema_version = backup_row.schema_version,
         updated_at = now(),
         updated_by = actor
   where id = 1;

  insert into public.lab_audit_logs(request_id, action, base_revision, resulting_revision, actor_id, entity_summary)
  values (p_request_id, 'restore', current_row.revision, next_revision, actor,
          jsonb_build_object('sourceBackupId', p_backup_id, 'sourceRevision', backup_row.source_revision, 'beforeRestoreSnapshotId', before_restore_id));

  return jsonb_build_object('revision', next_revision, 'sourceBackupId', p_backup_id, 'beforeRestoreSnapshotId', before_restore_id, 'requestId', p_request_id, 'updatedAt', now());
end;
$$;

-- 執行權限：Supabase 預設會讓 anon（未登入）也能執行 public 底下的函式，要明確收回。
revoke all on function public.create_lab_backup(text) from public, anon, authenticated;
grant execute on function public.create_lab_backup(text) to service_role;

revoke all on function public.prune_lab_backups(integer, integer) from public, anon;
grant execute on function public.prune_lab_backups(integer, integer) to authenticated, service_role;

revoke all on function public.import_lab_state(jsonb, uuid) from public, anon;
grant execute on function public.import_lab_state(jsonb, uuid) to authenticated;

revoke all on function public.restore_lab_backup(uuid, uuid) from public, anon;
grant execute on function public.restore_lab_backup(uuid, uuid) to authenticated;

revoke all on function public.apply_lab_state_change(bigint, uuid, jsonb) from public, anon;
grant execute on function public.apply_lab_state_change(bigint, uuid, jsonb) to authenticated;

-- 建表語法的版本號。引導網頁與系統用它確認「這一段跑過了沒」：
-- 這一段沒有新增資料表或欄位，光看表在不在永遠問不出來。
create or replace function public.lab_schema_version()
returns integer
language sql immutable
as $$
  select 4;
$$;

grant execute on function public.lab_schema_version() to anon, authenticated, service_role;
