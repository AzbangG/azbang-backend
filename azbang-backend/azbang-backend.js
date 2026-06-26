/**
 * AZBANG SERVER LIST — Express Backend
 * ─────────────────────────────────────────────────────────
 * POST /api/servers  — receive data from Roblox Lua script
 * GET  /api/servers  — fetch servers for a place_id
 * GET  /api/games    — list all tracked games
 * POST /api/cleanup  — manually trigger stale cleanup
 * ─────────────────────────────────────────────────────────
 *
 * INSTALL:
 *   npm install express @supabase/supabase-js cors dotenv
 *
 * .env file:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=your_service_role_key   <-- use service key here (not anon)
 *   API_SECRET=your_lua_script_secret_token
 *   PORT=3001
 *
 * RUN:
 *   node azbang-backend.js
 *
 * DEPLOY FREE:
 *   Railway.app → connect GitHub → deploy → done
 *   Or Render.com → New Web Service → free tier
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Supabase client (service role for server-side writes) ───
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Auth middleware ─────────────────────────────────────────
// Optional but recommended — validates Lua script sends correct token
function requireSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // skip if not configured

  const token = req.headers['x-api-secret'] || req.body?.api_secret;
  if (token !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Validators ──────────────────────────────────────────────
function validateServerPayload(body) {
  const errors = [];

  if (!body.place_id || typeof body.place_id !== 'string' || body.place_id.trim() === '') {
    errors.push('place_id is required and must be a string');
  }
  if (!body.job_id || typeof body.job_id !== 'string' || body.job_id.trim() === '') {
    errors.push('job_id is required and must be a string');
  }
  if (!body.player_name || typeof body.player_name !== 'string') {
    errors.push('player_name is required');
  }
  if (body.player_count === undefined || body.player_count === null) {
    errors.push('player_count is required');
  } else {
    const cnt = parseInt(body.player_count, 10);
    if (isNaN(cnt) || cnt < 0 || cnt > 500) errors.push('player_count must be 0–500');
  }
  if (body.max_players === undefined || body.max_players === null) {
    errors.push('max_players is required');
  } else {
    const mx = parseInt(body.max_players, 10);
    if (isNaN(mx) || mx < 1 || mx > 500) errors.push('max_players must be 1–500');
  }

  return errors;
}

// ── POST /api/servers ───────────────────────────────────────
// Roblox Lua script sends here every 30-60 seconds
app.post('/api/servers', requireSecret, async (req, res) => {
  const errors = validateServerPayload(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const {
    place_id,
    job_id,
    player_name,
    player_count,
    max_players,
    game_name
  } = req.body;

  const placeId     = place_id.trim();
  const jobId       = job_id.trim();
  const playerName  = player_name.trim().slice(0, 64);
  const playerCount = parseInt(player_count, 10);
  const maxPlayers  = parseInt(max_players, 10);

  try {
    // ── Step 1: Ensure game entry exists ──────────────────
    const resolvedName = (game_name || '').trim().slice(0, 64) || `Game ${placeId}`;

    const { error: gameErr } = await supabase
      .from('games')
      .upsert(
        { place_id: placeId, game_name: resolvedName },
        { onConflict: 'place_id', ignoreDuplicates: true }
      );

    if (gameErr) {
      console.error('Game upsert error:', gameErr);
      return res.status(500).json({ error: 'Failed to register game', detail: gameErr.message });
    }

    // ── Step 2: Upsert server record ──────────────────────
    const { data, error: serverErr } = await supabase
      .from('servers')
      .upsert(
        {
          place_id:      placeId,
          job_id:        jobId,
          player_name:   playerName,
          player_count:  playerCount,
          max_players:   maxPlayers,
          server_status: 'active',
          last_update:   new Date().toISOString()
        },
        { onConflict: 'job_id' }
      )
      .select()
      .single();

    if (serverErr) {
      console.error('Server upsert error:', serverErr);
      return res.status(500).json({ error: 'Failed to save server', detail: serverErr.message });
    }

    // ── Step 3: Run passive stale cleanup ─────────────────
    // Mark servers not updated in 3+ minutes as inactive
    const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await supabase
      .from('servers')
      .update({ server_status: 'inactive' })
      .eq('server_status', 'active')
      .lt('last_update', staleThreshold);

    return res.status(200).json({
      success: true,
      server_id: data.id,
      place_id: placeId,
      job_id: jobId,
      timestamp: data.last_update
    });

  } catch (err) {
    console.error('Unexpected error in POST /api/servers:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/servers ────────────────────────────────────────
app.get('/api/servers', async (req, res) => {
  const { place_id, status, limit = 100 } = req.query;

  if (!place_id) {
    return res.status(400).json({ error: 'place_id query parameter is required' });
  }

  try {
    let query = supabase
      .from('servers')
      .select('*')
      .eq('place_id', place_id)
      .order('last_update', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 100, 500));

    if (status) {
      query = query.eq('server_status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('GET /api/servers error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ servers: data, count: data.length });

  } catch (err) {
    console.error('Unexpected error in GET /api/servers:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/games ──────────────────────────────────────────
app.get('/api/games', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('games')
      .select(`
        *,
        servers(count)
      `)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ games: data });

  } catch (err) {
    console.error('Unexpected error in GET /api/games:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/cleanup ───────────────────────────────────────
// Optional: call this from a cron job or Supabase edge function
app.post('/api/cleanup', requireSecret, async (_req, res) => {
  const staleThreshold = new Date(Date.now() - 3 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('servers')
      .update({ server_status: 'inactive' })
      .eq('server_status', 'active')
      .lt('last_update', staleThreshold)
      .select('id');

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      cleaned: data.length,
      threshold: staleThreshold
    });

  } catch (err) {
    console.error('Cleanup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Health check ────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Boot ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  AZBANG Backend API                    ║
║  Running on http://localhost:${PORT}      ║
║                                        ║
║  POST /api/servers  ← Roblox script    ║
║  GET  /api/servers  ← dashboard        ║
║  GET  /api/games    ← dashboard        ║
║  GET  /health       ← uptime monitor   ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;
