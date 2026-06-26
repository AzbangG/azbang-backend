/**
 * AZBANG BACKEND v2
 * ─────────────────────────────────────────────────
 * Changes from v1:
 *  - POST /api/servers  → accepts extra_data (JSONB)
 *  - DELETE inactive    → hard-deletes from DB on cleanup
 *  - POST /api/cleanup  → calls delete_inactive_servers()
 *  - GET  /api/servers  → returns extra_data field
 * ─────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
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
  if (isNaN(cnt) || cnt < 0 || cnt > 500)  errors.push('player_count must be 0–500');
  if (isNaN(mx)  || mx  < 1 || mx  > 500)  errors.push('max_players must be 1–500');
  return errors;
}

/* ── DELETE inactive servers ───────────────────── */
// Hard-deletes rows where status=inactive OR last_update > 3 minutes ago
async function deleteInactiveServers() {
  const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  // First mark stale active servers as inactive
  await supabase
    .from('servers')
    .update({ server_status: 'inactive' })
    .eq('server_status', 'active')
    .lt('last_update', staleThreshold);

  // Then hard-delete all inactive
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
  if (count > 0) console.log(`[Cleanup] Deleted ${count} inactive/stale servers from DB`);
  return count;
}

/* ── POST /api/servers ─────────────────────────── */
app.post('/api/servers', requireSecret, async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const {
    place_id, job_id, player_name,
    player_count, max_players, game_name,
    extra_data  // ← new: any game-specific JSON object
  } = req.body;

  const placeId     = place_id.trim();
  const jobId       = job_id.trim();
  const playerName  = player_name.trim().slice(0, 64);
  const playerCount = parseInt(player_count, 10);
  const maxPlayers  = parseInt(max_players,  10);
  const resolvedName = (game_name || '').trim().slice(0, 64) || `Game ${placeId}`;

  // Validate extra_data — must be object or null
  let extraData = {};
  if (extra_data && typeof extra_data === 'object' && !Array.isArray(extra_data)) {
    // Sanitize: remove any keys that could cause issues, limit size
    const str = JSON.stringify(extra_data);
    if (str.length <= 4096) {
      extraData = extra_data;
    } else {
      console.warn('extra_data too large, truncating to empty');
    }
  }

  try {
    // 1. Ensure game exists
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

    // 2. Upsert server with extra_data
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
          extra_data:    extraData
        },
        { onConflict: 'job_id' }
      )
      .select()
      .single();

    if (srvErr) {
      console.error('Server upsert:', srvErr.message);
      return res.status(500).json({ error: 'Failed to save server' });
    }

    // 3. Hard-delete inactive servers (runs passively on each heartbeat)
    deleteInactiveServers().catch(console.error);

    return res.status(200).json({
      success:   true,
      server_id: data.id,
      place_id:  placeId,
      job_id:    jobId,
      timestamp: data.last_update
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── GET /api/servers ──────────────────────────── */
app.get('/api/servers', async (req, res) => {
  const { place_id, status, limit = 100 } = req.query;
  if (!place_id) return res.status(400).json({ error: 'place_id required' });

  try {
    let q = supabase
      .from('servers')
      .select('*')                          // includes extra_data
      .eq('place_id', place_id)
      .order('last_update', { ascending: false })
      .limit(Math.min(parseInt(limit,10)||100, 500));

    if (status) q = q.eq('server_status', status);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ servers: data, count: data.length });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── GET /api/games ────────────────────────────── */
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

/* ── POST /api/cleanup ─────────────────────────── */
// Manual trigger — call from cron job, Supabase edge function, or UptimeRobot
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
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  AZBANG Backend v2 — port ${PORT}           ║
║  POST /api/servers  ← Roblox (+ extra)   ║
║  GET  /api/servers  ← dashboard          ║
║  GET  /api/games    ← dashboard          ║
║  POST /api/cleanup  ← cron / manual      ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
