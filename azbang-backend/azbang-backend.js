/**
 * AZBANG BACKEND v3
 * ─────────────────────────────────────────────────
 * Changes from v2:
 *  - extra_data size limit: 4 KB → 32 KB
 *  - deleteInactiveServers threshold: 3 min → 1 min (sync with dashboard)
 *  - GET /api/servers: now accepts optional ?place_id filter
 *    (returns ALL active servers when place_id omitted — for dashboard)
 *  - GET /api/games:   deduped at DB level via UNIQUE constraint
 *  - Vercel route:     single file, all routes handled here
 * ─────────────────────────────────────────────────
 * REQUIRED: Run migration.sql in Supabase SQL Editor first.
 * ─────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/* ── Auth ──────────────────────────────────────── */
function requireSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  const token = req.headers['x-api-secret'] || req.body?.api_secret;
  if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ── Validate ──────────────────────────────────── */
function validatePayload(body) {
  const errors = [];
  if (!body.place_id || typeof body.place_id !== 'string') errors.push('place_id required');
  if (!body.job_id   || typeof body.job_id   !== 'string') errors.push('job_id required');
  if (!body.player_name)                                    errors.push('player_name required');
  const cnt = parseInt(body.player_count, 10);
  const mx  = parseInt(body.max_players,  10);
  if (isNaN(cnt) || cnt < 0 || cnt > 500) errors.push('player_count must be 0–500');
  if (isNaN(mx)  || mx  < 1 || mx  > 500) errors.push('max_players must be 1–500');
  return errors;
}

/* ── Stale threshold ───────────────────────────── */
// 60 000 ms = 1 minute — matches dashboard isStale() in v4
const STALE_MS = 60_000;

/* ── DELETE inactive / stale servers ──────────── */
async function deleteInactiveServers() {
  const staleThreshold = new Date(Date.now() - STALE_MS).toISOString();

  // Mark stale active servers as inactive
  await supabase
    .from('servers')
    .update({ server_status: 'inactive' })
    .eq('server_status', 'active')
    .lt('last_update', staleThreshold);

  // Hard-delete all inactive or stale rows
  const { data, error } = await supabase
    .from('servers')
    .delete()
    .or(`server_status.eq.inactive,last_update.lt.${staleThreshold}`)
    .select('id');

  if (error) {
    console.error('deleteInactiveServers error:', error.message);
    return 0;
  }

  const count = data?.length || 0;
  if (count > 0) console.log(`[Cleanup] Deleted ${count} inactive/stale server(s)`);
  return count;
}

/* ══════════════════════════════════════════════════
   POST /api/servers
   Called by Reporter.lua every 45s per server.
══════════════════════════════════════════════════ */
app.post('/api/servers', requireSecret, async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const {
    place_id, job_id, player_name,
    player_count, max_players, game_name,
    extra_data,
  } = req.body;

  const placeId      = place_id.trim();
  const jobId        = job_id.trim();
  const playerName   = player_name.trim().slice(0, 64);
  const playerCount  = parseInt(player_count, 10);
  const maxPlayers   = parseInt(max_players,  10);
  const resolvedName = (game_name || '').trim().slice(0, 64) || `Game ${placeId}`;

  // Sanitize extra_data — object only, max 32 KB
  let extraData = {};
  if (extra_data && typeof extra_data === 'object' && !Array.isArray(extra_data)) {
    const str = JSON.stringify(extra_data);
    if (str.length <= 32_768) {
      extraData = extra_data;
    } else {
      // Payload too large — strip wild_pets array (largest field) and retry
      const trimmed = { ...extra_data, wild_pets: undefined };
      const str2 = JSON.stringify(trimmed);
      extraData = str2.length <= 32_768 ? trimmed : {};
      console.warn(`[Warning] extra_data trimmed: ${str.length}B → ${JSON.stringify(extraData).length}B`);
    }
  }

  try {
    // 1. Upsert game — requires UNIQUE constraint on games.place_id
    const { error: gameErr } = await supabase
      .from('games')
      .upsert(
        { place_id: placeId, game_name: resolvedName },
        { onConflict: 'place_id', ignoreDuplicates: true }
      );

    if (gameErr) {
      console.error('Game upsert:', gameErr.message);
      return res.status(500).json({ error: 'Failed to register game' });
    }

    // 2. Upsert server — requires UNIQUE constraint on servers.job_id
    const { data, error: srvErr } = await supabase
      .from('servers')
      .upsert(
        {
          place_id:      placeId,
          job_id:        jobId,
          player_name:   playerName,
          player_count:  playerCount,
          max_players:   maxPlayers,
          server_status: 'active',
          last_update:   new Date().toISOString(),
          extra_data:    extraData,
        },
        { onConflict: 'job_id' }
      )
      .select()
      .single();

    if (srvErr) {
      console.error('Server upsert:', srvErr.message);
      return res.status(500).json({ error: 'Failed to save server' });
    }

    // 3. Passive cleanup — fire-and-forget on each heartbeat
    deleteInactiveServers().catch(console.error);

    return res.status(200).json({
      success:   true,
      server_id: data.id,
      place_id:  placeId,
      job_id:    jobId,
      timestamp: data.last_update,
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ══════════════════════════════════════════════════
   GET /api/servers
   Dashboard fetches this directly via Supabase REST,
   but this route is kept for backend-proxied access.
   ?place_id=  (optional) — filter by game
   ?status=    (optional) — filter by server_status
   ?limit=     (optional, default 100, max 500)
══════════════════════════════════════════════════ */
app.get('/api/servers', async (req, res) => {
  const { place_id, status, limit = 100 } = req.query;

  try {
    let q = supabase
      .from('servers')
      .select('*')
      .order('last_update', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));

    // place_id is now OPTIONAL — omit to get all servers
    if (place_id) q = q.eq('place_id', place_id.trim());
    if (status)   q = q.eq('server_status', status);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ servers: data, count: data.length });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ══════════════════════════════════════════════════
   GET /api/games
   Returns all unique games.
══════════════════════════════════════════════════ */
app.get('/api/games', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('games')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ games: data });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ══════════════════════════════════════════════════
   DELETE /api/servers?job_id=<job_id>
   Called by Reporter.lua when LocalPlayer leaves.
   Hard-deletes the specific server row immediately.
══════════════════════════════════════════════════ */
app.delete('/api/servers', requireSecret, async (req, res) => {
  const job_id = (req.query.job_id || '').trim();
  if (!job_id) return res.status(400).json({ error: 'job_id required' });

  try {
    const { data, error } = await supabase
      .from('servers')
      .delete()
      .eq('job_id', job_id)
      .select('id');

    if (error) {
      console.error('Server delete error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const count = data?.length || 0;
    if (count > 0) console.log(`[Delete] Removed server job_id=${job_id}`);
    else           console.log(`[Delete] job_id=${job_id} not found (already gone)`);

    return res.status(200).json({ deleted: count, job_id });
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ══════════════════════════════════════════════════
   POST /api/cleanup
   Manual trigger — cron job, UptimeRobot, Supabase Edge Function.
══════════════════════════════════════════════════ */
app.post('/api/cleanup', requireSecret, async (_req, res) => {
  try {
    const deleted = await deleteInactiveServers();
    return res.status(200).json({ deleted, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── Health ────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'ok',
    version:   'v3',
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  AZBANG Backend v3 — port ${PORT}           ║
║  POST /api/servers  ← Reporter.lua       ║
║  GET  /api/servers  ← dashboard (opt.)   ║
║  GET  /api/games    ← dashboard          ║
║  POST /api/cleanup  ← cron / manual      ║
║  Stale threshold: 60s (sync dashboard)   ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
