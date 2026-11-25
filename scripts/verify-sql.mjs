// 驗證建表語法真的能跑起來。
//
// 為什麼需要這支：助理在引導網頁第 5 步貼進 Supabase 的，就是
// supabase/migrations/ 裡那兩段 SQL。那兩段只要有一個字打錯
// （例如樣板字串把 `$$` 吃成 `$`），**每一個研究室都會卡在同一步**，
// 而且錯誤訊息是 PostgreSQL 的語法錯誤，助理完全看不懂。
//
// 而一般的檢查只比對「檔案內容有沒有變」，不會發現「內容本身跑不起來」。
// 這支會把 SQL 丟進一個真的 PostgreSQL（PGlite，編譯成 WebAssembly 的
// PostgreSQL，不需要安裝資料庫）執行，然後檢查結果。
//
// 使用方式：
//
//   npm install --no-save @electric-sql/pglite   # 只在要驗證時裝，不進版控
//   node scripts/verify-sql.mjs
//
// 刻意不把它列進 package.json 的依賴：專案要維持「零 npm 依賴」，
// 任何人都能不裝東西就把它跑起來。這支是維護者改動 SQL 之後的額外把關。
// `npm run test:all` 不會跑它（因為它需要額外安裝）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIGRATIONS = [
  'supabase/migrations/001_lab_state.sql',
  'supabase/migrations/002_lab_settings.sql'
];

let failed = 0;
// 要 await：有些檢查本身要查資料庫（async），不 await 會印出 [object Promise]。
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`✔ ${name}${detail && detail !== true ? ` — ${detail}` : ''}`);
  } catch (error) {
    console.log(`✘ ${name} — ${error.message}`);
    failed += 1;
  }
}

// 從引導網頁取出「助理真正會貼上的那兩段」，而不是直接讀 migration 檔。
// 為什麼：內嵌到 HTML 的過程才是最容易出錯的地方（`$$` 這類樣板字串陷阱），
// 驗證助理手上那份，才有意義。
function readWizardSqlSegments() {
  const html = fs.readFileSync(path.join(ROOT, 'wizard/index.html'), 'utf8');
  const pattern = /<script type="text\/plain" class="migration-sql"[^>]*data-sql-segment[^>]*>([\s\S]*?)<\/script>/g;
  const segments = [];
  for (const match of html.matchAll(pattern)) {
    // 說明用的範例區塊（內容是「…SQL 原文…」）要排除
    if (match[1].includes('…SQL 原文…')) continue;
    segments.push(match[1].replace(/^\n+/, '').replace(/\s+$/, ''));
  }
  return segments;
}

async function loadPGlite() {
  try {
    return await import('@electric-sql/pglite');
  } catch {
    console.log('找不到 @electric-sql/pglite。先執行：');
    console.log('  npm install --no-save @electric-sql/pglite');
    console.log('再跑一次 node scripts/verify-sql.mjs');
    process.exit(2);
  }
}

const { PGlite } = await loadPGlite();

const segments = readWizardSqlSegments();
console.log('\n【引導網頁裡助理實際會貼上的建表語法】');
await check('取出兩段語法', () => {
  if (segments.length !== MIGRATIONS.length) {
    throw new Error(`預期 ${MIGRATIONS.length} 段，實際 ${segments.length} 段`);
  }
  return `共 ${segments.length} 段`;
});

await check('兩段語法與 migration 檔逐字相同', () => {
  const problems = [];
  MIGRATIONS.forEach((rel, index) => {
    const onDisk = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\s+$/, '');
    if (segments[index] !== onDisk) {
      // 找出第一個不一樣的地方，直接指出來，比對長度更快看出是哪種問題
      let at = 0;
      while (at < segments[index].length && at < onDisk.length && segments[index][at] === onDisk[at]) at += 1;
      problems.push(`${rel} 第 ${at} 字元起不同`);
    }
  });
  if (problems.length) throw new Error(problems.join('；'));
  return true;
});

// 這是實際會發生、而且很難自己看出來的錯：JS 的樣板字串／字串替換會把 `$$` 吃掉。
await check('PostgreSQL 的 $$ 沒有被吃掉', () => {
  const problems = [];
  segments.forEach((sql, index) => {
    // `do $$ begin … end $$;` 這類區塊，$ 的數量必須成對
    const dollars = (sql.match(/\$\$/g) || []).length;
    const singleDollar = (sql.match(/(?<!\$)\$(?!\$)/g) || []).length;
    if (singleDollar > 0) {
      problems.push(`第 ${index + 1} 段有不成對的 $（${singleDollar} 個），可能是 $$ 被吃掉`);
    }
    if (dollars === 0) problems.push(`第 ${index + 1} 段找不到任何 $$`);
  });
  if (problems.length) throw new Error(problems.join('；'));
  return '$$ 數量正確';
});

console.log('\n【實際執行】');

const db = await new PGlite();

// Supabase 有、但空的 PostgreSQL 沒有的東西。這些是 Supabase 平台的既有設施，
// 不是我們的 migration 該負責的部分，所以測試時補上。
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

  create schema if not exists extensions;
  create or replace function extensions.digest(data bytea, typ text) returns bytea
    language sql immutable as $$ select sha256(data) $$;

  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`);

for (let index = 0; index < segments.length; index += 1) {
  const label = MIGRATIONS[index].split('/').pop();
  // 001 開頭的 pgcrypto 是 Supabase 內建的擴充，空的 PostgreSQL 沒有
  const sql = segments[index].replace(
    /create extension if not exists pgcrypto;/i,
    '-- pgcrypto：Supabase 內建，這裡略過'
  );
  try {
    await db.exec(sql);
    console.log(`✔ ${label} 執行成功`);
  } catch (error) {
    console.log(`✘ ${label} 執行失敗 — ${error.message}`);
    failed += 1;
  }
}

const tables = (await db.query(
  `select tablename from pg_tables where schemaname = 'public' order by tablename`
)).rows.map(row => row.tablename);

console.log('\n【執行結果檢查】');

const EXPECTED_TABLES = ['lab_audit_logs', 'lab_backup_runs', 'lab_backups', 'lab_profiles', 'lab_settings', 'lab_state'];
await check('該有的資料表都建立了', () => {
  const missing = EXPECTED_TABLES.filter(name => !tables.includes(name));
  if (missing.length) throw new Error(`缺少：${missing.join('、')}`);
  return tables.join(', ');
});

await check('每一張表都啟用了 RLS', async () => {
  const rows = (await db.query(
    `select relname, relrowsecurity from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`
  )).rows;
  const without = rows.filter(row => !row.relrowsecurity).map(row => row.relname);
  if (without.length) throw new Error(`沒開 RLS：${without.join('、')}`);
  return `${rows.length} 張表都開了`;
});

await check('lab_settings 沒有 insert 政策', async () => {
  const rows = (await db.query(
    `select policyname, cmd from pg_policies
     where schemaname = 'public' and tablename = 'lab_settings'`
  )).rows;
  const inserts = rows.filter(row => row.cmd === 'INSERT');
  if (inserts.length) throw new Error(`竟然有 insert 政策：${inserts.map(row => row.policyname).join('、')}`);
  return '第一列只能由伺服器金鑰建立';
});

await check('關鍵函式都建立了', async () => {
  const EXPECTED = [
    'apply_lab_state_change', 'can_use_lab_data', 'create_lab_backup',
    'current_lab_role', 'import_lab_state', 'jsonb_sha256',
    'prune_lab_backups', 'restore_lab_backup'
  ];
  const names = (await db.query(
    `select proname from pg_proc where pronamespace = 'public'::regnamespace`
  )).rows.map(row => row.proname);
  const missing = EXPECTED.filter(name => !names.includes(name));
  if (missing.length) throw new Error(`缺少：${missing.join('、')}`);
  return `${names.length} 個函式`;
});

await check('jsonb_sha256 能算出正確的雜湊', async () => {
  const result = await db.query(`select public.jsonb_sha256('{"a":1}'::jsonb) as hash`);
  const hash = result.rows[0]?.hash;
  if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) throw new Error(`算出來不是 sha256：${hash}`);
  return String(hash).slice(0, 16) + '…';
});

await db.close();

console.log(failed === 0
  ? '\n✔ 建表語法可以真的跑起來，結構也正確'
  : `\n✘ 有 ${failed} 項失敗`);
process.exit(failed ? 1 : 0);
