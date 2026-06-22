require('dotenv').config();
const express    = require('express');
const mysql      = require('mysql2/promise');
const session      = require('express-session');
const MySQLStore   = require('express-mysql-session')(session);
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const db = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               process.env.DB_PORT     || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'horizon_db',
  waitForConnections: true,
  connectionLimit:    10,
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionStore = new MySQLStore({
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'id',
      expires:    'expires_at',
      data:       'data',
    }
  }
}, db);

app.use(session({
  secret:            process.env.SESSION_SECRET || 'change_me_in_production',
  resave:            false,
  saveUninitialized: false,
  store:             sessionStore,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  },
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:5001';
const PYTHON_API_KEY  = process.env.PYTHON_API_KEY || '';
const SERPAPI_KEY     = process.env.SERPAPI_KEY || '';

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [[user]] = await db.execute('SELECT email FROM users WHERE id = ?', [req.session.userId]);
    if (!user || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  } catch (err) {
    console.error('Admin check error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function callPythonApi(pathName, res) {
  try {
    const r = await fetch(`${PYTHON_API_URL}${pathName}`, {
      headers: { 'X-Internal-Key': PYTHON_API_KEY },
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Python API returned ${r.status}` });
    }
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    console.error('Python API error:', err.message);
    return res.status(503).json({ error: 'Analytics API is unreachable. Is the Jupyter notebook running?' });
  }
}

function entryKey(item1, item2) {
  const urls = [item1.url, item2.url].sort();
  return crypto.createHash('sha1').update(urls.join('|')).digest('hex');
}

app.get('/api/search', async (req, res) => {
  const { q, platform } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
  if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not configured on server' });

  const platformNames = { shopee: 'Shopee', lazada: 'Lazada', tiktok: 'TikTok Shop' };
  const searchQuery = platform && platform !== 'all'
    ? `${q} ${platformNames[platform] || ''}`
    : `${q} Shopee OR Lazada OR TikTok Shop`;

  const serpUrl = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(searchQuery)}&api_key=${SERPAPI_KEY}&num=40&gl=ph&hl=en`;

  try {
    const r = await fetch(serpUrl);
    if (!r.ok) {
      return res.status(502).json({ error: `SerpApi returned ${r.status}` });
    }
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    console.error('SerpApi error:', err.message);
    return res.status(503).json({ error: 'Search service is unreachable' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' });

  try {

    const gRes  = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!gRes.ok) return res.status(401).json({ error: 'Invalid Google token' });

    const { sub, email, name, picture } = await gRes.json();

    const [rows] = await db.execute(
      `INSERT INTO users (google_sub, email, name, picture)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         email   = VALUES(email),
         name    = VALUES(name),
         picture = VALUES(picture)`,
      [sub, email, name, picture]
    );

    const [[user]] = await db.execute(
      'SELECT id, name, email, picture FROM users WHERE google_sub = ?', [sub]
    );

    req.session.userId = user.id;
    return res.json({ user });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const [[user]] = await db.execute(
    'SELECT id, name, email, picture, created_at FROM users WHERE id = ?',
    [req.session.userId]
  );
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/favorites', requireAuth, async (req, res) => {
  const [rows] = await db.execute(
    `SELECT id, item1, item2, saved_at
     FROM favorites
     WHERE user_id = ?
     ORDER BY saved_at DESC
     LIMIT 50`,
    [req.session.userId]
  );

  const entries = rows.map(r => ({
    id:      r.id,
    savedAt: new Date(r.saved_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
    item1:   typeof r.item1 === 'string' ? JSON.parse(r.item1) : r.item1,
    item2:   typeof r.item2 === 'string' ? JSON.parse(r.item2) : r.item2,
  }));
  return res.json(entries);
});

app.post('/api/favorites', requireAuth, async (req, res) => {
  const { item1, item2 } = req.body;
  if (!item1 || !item2) return res.status(400).json({ error: 'item1 and item2 required' });

  const key = entryKey(item1, item2);
  try {
    const [result] = await db.execute(
      `INSERT INTO favorites (user_id, entry_key, item1, item2)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE saved_at = CURRENT_TIMESTAMP`,
      [req.session.userId, key, JSON.stringify(item1), JSON.stringify(item2)]
    );

    const [[row]] = await db.execute(
      'SELECT id, saved_at FROM favorites WHERE user_id = ? AND entry_key = ?',
      [req.session.userId, key]
    );
    return res.json({
      id:      row.id,
      savedAt: new Date(row.saved_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
      item1, item2,
    });
  } catch (err) {
    console.error('Add favorite error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/favorites/:id', requireAuth, async (req, res) => {
  await db.execute(
    'DELETE FROM favorites WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.userId]
  );
  return res.json({ ok: true });
});

app.delete('/api/favorites', requireAuth, async (req, res) => {
  await db.execute('DELETE FROM favorites WHERE user_id = ?', [req.session.userId]);
  return res.json({ ok: true });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const [rows] = await db.execute(
    `SELECT id, item1, item2, compared_at
     FROM compare_history
     WHERE user_id = ?
     ORDER BY compared_at DESC
     LIMIT 20`,
    [req.session.userId]
  );
  const entries = rows.map(r => ({
    id:      r.id,
    savedAt: new Date(r.compared_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
    item1:   typeof r.item1 === 'string' ? JSON.parse(r.item1) : r.item1,
    item2:   typeof r.item2 === 'string' ? JSON.parse(r.item2) : r.item2,
  }));
  return res.json(entries);
});

app.post('/api/history', requireAuth, async (req, res) => {
  const { item1, item2 } = req.body;
  if (!item1 || !item2) return res.status(400).json({ error: 'item1 and item2 required' });

  const [[{ cnt }]] = await db.execute(
    'SELECT COUNT(*) AS cnt FROM compare_history WHERE user_id = ?',
    [req.session.userId]
  );
  if (cnt >= 20) {

    await db.execute(
      `DELETE FROM compare_history WHERE user_id = ?
       ORDER BY compared_at ASC LIMIT 1`,
      [req.session.userId]
    );
  }

  const [result] = await db.execute(
    'INSERT INTO compare_history (user_id, item1, item2) VALUES (?, ?, ?)',
    [req.session.userId, JSON.stringify(item1), JSON.stringify(item2)]
  );
  const [[row]] = await db.execute(
    'SELECT id, compared_at FROM compare_history WHERE id = ?',
    [result.insertId]
  );
  return res.json({
    id:      row.id,
    savedAt: new Date(row.compared_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
    item1, item2,
  });
});

app.delete('/api/history/:id', requireAuth, async (req, res) => {
  await db.execute(
    'DELETE FROM compare_history WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.userId]
  );
  return res.json({ ok: true });
});

app.delete('/api/history', requireAuth, async (req, res) => {
  await db.execute('DELETE FROM compare_history WHERE user_id = ?', [req.session.userId]);
  return res.json({ ok: true });
});

app.get('/api/admin/check', requireAuth, async (req, res) => {
  const [[user]] = await db.execute('SELECT email FROM users WHERE id = ?', [req.session.userId]);
  const isAdmin = !!user && ADMIN_EMAILS.includes(user.email.toLowerCase());
  return res.json({ isAdmin });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => callPythonApi('/stats', res));

app.get('/api/admin/users', requireAdmin, (req, res) => callPythonApi('/users', res));

app.get('/api/__debug_routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(layer => {
    if (layer.route) {
      routes.push(`${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
    }
  });
  res.json(routes);
});

app.listen(PORT, () => {
  console.log(`Horizon API running at http://localhost:${PORT}`);
});
