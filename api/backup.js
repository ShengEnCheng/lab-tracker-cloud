import { timingSafeEqual } from 'node:crypto';
import { methodAllowed, sendJson, supabaseServerFetch } from './_supabase.js';

// 誰可以觸發備份。
//
// 有設定 CRON_SECRET（部署時引導網頁會請使用者產生一組）：
//   只認密碼。Vercel 的排程會自動帶上 `Authorization: Bearer <CRON_SECRET>`。
//   `x-vercel-cron` 標頭一律不認 —— 那是請求的人自己填的，任何人都能偽造。
//
// 為什麼這很重要：每次備份完都會清理，只留最近 30 份每日備份。有人連敲 30 次，
// 舊的好備份就全部被擠掉、換成 30 份「現況」—— 資料被改壞時就沒有舊版可以還原。
//
// 沒有設定 CRON_SECRET（這個版本之前部署的研究室）：
//   退回舊的判斷，讓他們的每日備份不會因為自動更新而突然停掉。
//   /api/setup-status 會回報「還沒設定 CRON_SECRET」，提醒他們補上。
export function isCronAuthorized(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '').trim();
  if (secret) {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    return timingSafeEqualText(supplied, secret);
  }
  return req.headers['x-vercel-cron'] === '1';
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function taipeiKind() {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(new Date());
  return weekday === 'Sun' ? 'weekly' : 'scheduled';
}

async function writeRun(runId, patch) {
  return supabaseServerFetch(`/rest/v1/lab_backup_runs?id=eq.${runId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return methodAllowed(res, ['GET', 'POST']);
  if (!isCronAuthorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

  const kind = taipeiKind();
  let runId;
  try {
    const run = await supabaseServerFetch('/rest/v1/lab_backup_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ kind, status: 'running', attempts: 1 })
    });
    const runRows = await run.json();
    if (!run.ok) return sendJson(res, run.status, { error: 'backup_run_start_failed', details: runRows });
    runId = runRows?.[0]?.id;

    const response = await supabaseServerFetch('/rest/v1/rpc/create_lab_backup', {
      method: 'POST',
      body: JSON.stringify({ p_kind: kind })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.message || result?.error || 'backup_create_failed');

    const prune = await supabaseServerFetch('/rest/v1/rpc/prune_lab_backups', {
      method: 'POST',
      body: JSON.stringify({ p_daily_keep: 30, p_weekly_keep: 12 })
    });
    const pruneResult = await prune.json();
    if (!prune.ok) throw new Error(pruneResult?.message || pruneResult?.error || 'backup_prune_failed');

    if (runId) await writeRun(runId, {
      status: 'succeeded',
      backup_id: result.backupId,
      source_revision: result.sourceRevision,
      finished_at: new Date().toISOString()
    });
    return sendJson(res, 200, {
      ok: true,
      ...result,
      checksum: result.checksum,
      runId,
      prunedCount: Number(pruneResult) || 0
    });
  } catch (error) {
    if (runId) {
      await writeRun(runId, {
        status: 'failed',
        error_message: String(error.message || 'backup_unavailable').slice(0, 1000),
        finished_at: new Date().toISOString()
      }).catch(() => {});
    }
    if (error.message === 'supabase_not_configured') return sendJson(res, 503, { error: 'backend_not_configured' });
    console.error('backup api error', error);
    return sendJson(res, 503, { error: 'backup_unavailable', message: '備份失敗，主資料未被刪除，可稍後重試。' });
  }
}
