/**
 * ═══════════════════════════════════════════════════════════════
 *  DISTORE MASTER SERVER v3.0  (PostgreSQL Edition)
 *  by Dilly Solutions
 * ═══════════════════════════════════════════════════════════════
 *
 *  Deployed on Render.com with PostgreSQL database
 *
 *  ENVIRONMENT VARIABLES (set on Render dashboard):
 *    DATABASE_URL   = postgresql://... (from Render Postgres)
 *    JWT_SECRET     = any long random string
 *    ADMIN_EMAIL    = evansmaina2026@gmail.com
 *    ADMIN_PASSWORD = Dilly@2026!
 *    PORT           = (Render sets this automatically)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');
const os     = require('os');

let express, socketIO, jwt, bcrypt, pg;
try { express  = require('express');       } catch(e) { die('express');      }
try { socketIO = require('socket.io');     } catch(e) { die('socket.io');    }
try { jwt      = require('jsonwebtoken');  } catch(e) { die('jsonwebtoken'); }
try { bcrypt   = require('bcryptjs');      } catch(e) { die('bcryptjs');     }
try { pg       = require('pg');            } catch(e) { die('pg');           }

function die(pkg) {
  console.error(`\n❌  Missing: ${pkg}\n   Run: npm install\n`);
  process.exit(1);
}

// ── Config ─────────────────────────────────────────────────────
const PORT       = process.env.PORT           || 3000;
const JWT_SECRET = process.env.JWT_SECRET     || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL= process.env.ADMIN_EMAIL    || 'evansmaina2026@gmail.com';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'Dilly@2026!';
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_EXP    = '7d';

if (!DATABASE_URL) {
  console.error('\n❌  DATABASE_URL environment variable is required');
  console.error('   Add it in Render dashboard → Environment\n');
  process.exit(1);
}

// ── PostgreSQL Pool ─────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Render
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Helper — run a query
async function q(text, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// Helper — get one row
async function qOne(text, params = []) {
  const res = await q(text, params);
  return res.rows[0] || null;
}

// Helper — get all rows
async function qAll(text, params = []) {
  const res = await q(text, params);
  return res.rows;
}

// Helper — insert and return inserted row id
async function qInsert(text, params = []) {
  const res = await q(text + ' RETURNING id', params);
  return res.rows[0]?.id;
}

// ── Create tables ───────────────────────────────────────────────
async function setupDatabase() {
  console.log('🗄️  Setting up database...');
  await q(`
    CREATE TABLE IF NOT EXISTS master_users (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'ADMIN',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_login TIMESTAMP
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id         SERIAL PRIMARY KEY,
      key_value  TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      created_by INTEGER REFERENCES master_users(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_used  TIMESTAMP,
      active     INTEGER NOT NULL DEFAULT 1
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS owners (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password      TEXT NOT NULL,
      name          TEXT NOT NULL,
      business_name TEXT NOT NULL,
      phone         TEXT,
      kra_pin       TEXT,
      status        TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      created_by    INTEGER REFERENCES master_users(id),
      last_login    TIMESTAMP,
      notes         TEXT
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS shops (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      location    TEXT,
      phone       TEXT,
      email       TEXT,
      kra_pin     TEXT,
      license_key TEXT UNIQUE NOT NULL,
      status      TEXT NOT NULL DEFAULT 'ACTIVE',
      plan        TEXT NOT NULL DEFAULT 'BASIC',
      features    TEXT NOT NULL DEFAULT '{}',
      monthly_fee NUMERIC NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMP,
      owner_id    INTEGER REFERENCES owners(id) ON DELETE SET NULL
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS feature_catalog (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      price_kes   NUMERIC NOT NULL DEFAULT 0,
      category    TEXT NOT NULL DEFAULT 'general',
      active      INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      shop_id      INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      feature_key  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'ACTIVE',
      price_kes    NUMERIC NOT NULL DEFAULT 0,
      started_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMP,
      renewed_at   TIMESTAMP,
      cancelled_at TIMESTAMP,
      UNIQUE(owner_id, shop_id, feature_key)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS feature_requests (
      id            SERIAL PRIMARY KEY,
      owner_id      INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      shop_id       INTEGER REFERENCES shops(id),
      feature_key   TEXT NOT NULL,
      feature_name  TEXT NOT NULL,
      message       TEXT,
      status        TEXT NOT NULL DEFAULT 'PENDING',
      price_kes     NUMERIC,
      reviewed_by   INTEGER REFERENCES master_users(id),
      reviewed_at   TIMESTAMP,
      reject_reason TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS payments (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES owners(id),
      shop_id      INTEGER REFERENCES shops(id),
      feature_key  TEXT,
      amount_kes   NUMERIC NOT NULL,
      method       TEXT NOT NULL DEFAULT 'MANUAL',
      reference    TEXT,
      description  TEXT,
      recorded_by  INTEGER REFERENCES master_users(id),
      created_at   TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS devices (
      id            SERIAL PRIMARY KEY,
      device_id     TEXT UNIQUE NOT NULL,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name          TEXT NOT NULL DEFAULT 'Unknown Device',
      type          TEXT NOT NULL DEFAULT 'phone',
      os            TEXT,
      browser       TEXT,
      ip_address    TEXT,
      status        TEXT NOT NULL DEFAULT 'PENDING',
      pos_user      TEXT,
      last_seen     TIMESTAMP,
      registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
      approved_at   TIMESTAMP,
      approved_by   INTEGER REFERENCES master_users(id)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS cloud_backups (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      device_id    TEXT NOT NULL,
      store_name   TEXT NOT NULL,
      data         TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      synced_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, device_id, store_name)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS remote_commands (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      device_id    TEXT,
      command      TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'PENDING',
      issued_by    INTEGER REFERENCES master_users(id),
      issued_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMP
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS server_audit (
      id      SERIAL PRIMARY KEY,
      ts      TIMESTAMP NOT NULL DEFAULT NOW(),
      actor   TEXT,
      action  TEXT NOT NULL,
      target  TEXT,
      details TEXT,
      ip      TEXT
    )
  `);

  // ── Device lock state ─────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS device_locks (
    id          SERIAL PRIMARY KEY,
    shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    device_id   TEXT,
    locked      INTEGER NOT NULL DEFAULT 1,
    message     TEXT,
    contact     TEXT,
    phone       TEXT,
    locked_by   INTEGER REFERENCES master_users(id),
    locked_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    unlocked_at TIMESTAMP
  )`);

  await q(`CREATE TABLE IF NOT EXISTS modules (
    id           SERIAL PRIMARY KEY,
    module_id    TEXT NOT NULL,
    shop_id      INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    device_id    TEXT,
    name         TEXT NOT NULL,
    description  TEXT,
    html         TEXT,
    css          TEXT,
    js           TEXT,
    mount_point  TEXT DEFAULT 'app',
    active       INTEGER NOT NULL DEFAULT 1,
    force_reload INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER REFERENCES master_users(id),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS patches (
    id         SERIAL PRIMARY KEY,
    patch_id   TEXT NOT NULL UNIQUE,
    shop_id    INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    content    TEXT NOT NULL,
    selector   TEXT,
    action     TEXT DEFAULT 'append',
    active     INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES master_users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS server_config (
    id        SERIAL PRIMARY KEY,
    label     TEXT NOT NULL,
    url       TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 0,
    added_by  INTEGER REFERENCES master_users(id),
    added_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    notes     TEXT
  )`);

  await q(`CREATE TABLE IF NOT EXISTS support_config (
    id         SERIAL PRIMARY KEY,
    key        TEXT NOT NULL UNIQUE,
    value      TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await q(`INSERT INTO support_config(key,value) VALUES('contact','evansmaina2026@gmail.com'),('phone','0114698986'),('name','Dilly Solutions') ON CONFLICT(key) DO NOTHING`);

  // Indexes
  await q(`CREATE INDEX IF NOT EXISTS idx_devices_shop     ON devices(shop_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_commands_pending ON remote_commands(shop_id, status)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_audit_ts         ON server_audit(ts)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_subs_owner       ON subscriptions(owner_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_requests_status  ON feature_requests(status)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_payments_owner   ON payments(owner_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_backups_shop     ON cloud_backups(shop_id)`);

  console.log('✅  Database tables ready');

  // Seed superadmin
  const existing = await qOne('SELECT id FROM master_users WHERE role = $1', ['SUPERADMIN']);
  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    await q('INSERT INTO master_users(email, password, name, role) VALUES($1,$2,$3,$4)', [ADMIN_EMAIL, hash, 'Dilly (Superadmin)', 'SUPERADMIN']);
    console.log(`🔑  Superadmin created: ${ADMIN_EMAIL}`);
  }

  // Seed feature catalog
  const featCount = await qOne('SELECT COUNT(*) as c FROM feature_catalog');
  if (parseInt(featCount.c) === 0) {
    const feats = [
      ['mpesa',         'M-PESA Payments',      'Accept Lipa Na M-PESA STK Push payments at checkout',          500,  'payments',   1],
      ['etims',         'eTIMS / KRA Tax',       'KRA eTIMS-compliant receipts with 16% VAT and KRA PIN',        1000, 'compliance', 2],
      ['reports',       'Advanced Reports',      'Sales reports, profit/loss, cashier performance, PDF export',  300,  'analytics',  3],
      ['analytics',     'Business Analytics',    'Charts, trends, product performance, peak hour analysis',      200,  'analytics',  4],
      ['multi_cashier', 'Multi-Cashier',         'Multiple cashier accounts with individual shift tracking',      300,  'operations', 5],
      ['credit',        'Credit & Layaway',       'Customer credit accounts, layaway plans, debt tracking',       400,  'operations', 6],
      ['payroll',       'Staff Payroll',          'Kenyan payroll with PAYE, NHIF, NSSF deductions',             500,  'hr',         7],
      ['repair',        'Repair Module',          'Track repair jobs, parts, labour, customer collection',        300,  'operations', 8],
      ['stocktake',     'Stock Take',             'Full stock count workflow with variance reports',              0,    'inventory',  9],
      ['supplier',      'Supplier Management',    'Supplier ledgers, GRN, purchase orders, credit tracking',     200,  'inventory',  10],
    ];
    for (const f of feats) {
      await q('INSERT INTO feature_catalog(key,name,description,price_kes,category,sort_order) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(key) DO NOTHING', f);
    }
    console.log('✅  Feature catalog seeded');
  }
}

// ── Helpers ─────────────────────────────────────────────────────
const ok  = (res, data, msg = 'OK') => res.json({ success: true,  msg, data });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, msg });
const genLicense = () => 'DST-' + crypto.randomBytes(6).toString('hex').toUpperCase();
const genApiKey  = () => 'dak_' + crypto.randomBytes(20).toString('hex');

async function audit(actor, action, target, details, ip) {
  try { await q('INSERT INTO server_audit(actor,action,target,details,ip) VALUES($1,$2,$3,$4,$5)', [actor||'system', action, target||null, details||null, ip||null]); } catch(e) {}
}

// ── Auth Middleware ──────────────────────────────────────────────
function authMaster(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return err(res, 'No token', 401);
  try { req.master = jwt.verify(token, JWT_SECRET); next(); }
  catch(e) { err(res, 'Invalid or expired token', 401); }
}

function authSuper(req, res, next) {
  authMaster(req, res, () => {
    if (req.master.role !== 'SUPERADMIN') return err(res, 'Superadmin only', 403);
    next();
  });
}

function authOwner(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return err(res, 'No token', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.type !== 'owner') return err(res, 'Owner token required', 401);
    qOne('SELECT * FROM owners WHERE id=$1 AND status=$2', [p.id, 'ACTIVE']).then(o => {
      if (!o) return err(res, 'Account not found or suspended', 401);
      req.owner = o; next();
    });
  } catch(e) { err(res, 'Invalid or expired token', 401); }
}

function authDevice(req, res, next) {
  const token      = req.headers['x-device-token'] || req.query.device_token || '';
  const licenseKey = req.headers['x-license-key']  || req.query.license_key  || '';
  if (!token || !licenseKey) return err(res, 'Device token + license key required', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.type !== 'device') return err(res, 'Invalid token type', 401);
    qOne(`SELECT d.*, s.features, s.status AS shop_status, s.plan, s.name AS shop_name
          FROM devices d JOIN shops s ON d.shop_id=s.id
          WHERE d.device_id=$1 AND s.license_key=$2`, [p.device_id, licenseKey]).then(d => {
      if (!d)                          return err(res, 'Device not found', 401);
      if (d.status === 'PENDING')      return err(res, 'DEVICE_PENDING: Waiting for admin approval', 403);
      if (d.status === 'BLOCKED')      return err(res, 'DEVICE_BLOCKED: This device is blocked', 403);
      if (d.shop_status === 'SUSPENDED') return err(res, 'SHOP_SUSPENDED: Shop account suspended', 403);
      req.device = d; req.shopId = d.shop_id;
      q('UPDATE devices SET last_seen=NOW(), ip_address=$1 WHERE device_id=$2', [req.ip, p.device_id]);
      next();
    });
  } catch(e) { err(res, 'Invalid device token', 401); }
}

// ── Express + Socket.IO ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000, pingInterval: 25000,
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization,X-Device-Token,X-License-Key,X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════════
//  MASTER API
// ══════════════════════════════════════════════════════════════

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/master/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return err(res, 'Email and password required');
    const u = await qOne('SELECT * FROM master_users WHERE email=$1 AND active=1', [email]);
    if (!u || !bcrypt.compareSync(password, u.password)) {
      await audit(email, 'MASTER_LOGIN_FAIL', null, null, req.ip);
      return err(res, 'Invalid credentials', 401);
    }
    await q('UPDATE master_users SET last_login=NOW() WHERE id=$1', [u.id]);
    await audit(u.email, 'MASTER_LOGIN', null, null, req.ip);
    const token = jwt.sign({ id:u.id, email:u.email, role:u.role, name:u.name }, JWT_SECRET, { expiresIn: JWT_EXP });
    ok(res, { token, user: { id:u.id, email:u.email, name:u.name, role:u.role } });
  } catch(e) { err(res, e.message, 500); }
});

app.get('/api/master/me', authMaster, async (req, res) => {
  const u = await qOne('SELECT id,email,name,role,created_at,last_login FROM master_users WHERE id=$1', [req.master.id]);
  ok(res, u);
});

app.post('/api/master/change-password', authMaster, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return err(res, 'Both passwords required');
    if (new_password.length < 8) return err(res, 'Min 8 characters');
    const u = await qOne('SELECT * FROM master_users WHERE id=$1', [req.master.id]);
    if (!bcrypt.compareSync(current_password, u.password)) return err(res, 'Wrong current password');
    await q('UPDATE master_users SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), u.id]);
    ok(res, null, 'Password changed');
  } catch(e) { err(res, e.message, 500); }
});

// ── Summary ───────────────────────────────────────────────────
app.get('/api/master/summary', authMaster, async (req, res) => {
  try {
    const [ts, as, td, pd, tc, tr, mr, pr] = await Promise.all([
      qOne('SELECT COUNT(*) as c FROM shops'),
      qOne("SELECT COUNT(*) as c FROM shops WHERE status='ACTIVE'"),
      qOne("SELECT COUNT(*) as c FROM devices WHERE status='APPROVED'"),
      qOne("SELECT COUNT(*) as c FROM devices WHERE status='PENDING'"),
      qOne('SELECT COUNT(*) as c FROM cloud_backups'),
      qOne('SELECT COALESCE(SUM(amount_kes),0) as t FROM payments'),
      qOne("SELECT COALESCE(SUM(amount_kes),0) as t FROM payments WHERE created_at >= date_trunc('month', NOW())"),
      qOne("SELECT COUNT(*) as c FROM feature_requests WHERE status='PENDING'"),
    ]);
    const la = await qOne('SELECT MAX(last_seen) as ts FROM devices');
    const ow = await qOne('SELECT COUNT(*) as c FROM owners');
    const ao = await qOne("SELECT COUNT(*) as c FROM owners WHERE status='ACTIVE'");
    ok(res, {
      totalShops: parseInt(ts.c), activeShops: parseInt(as.c),
      totalOwners: parseInt(ow.c), activeOwners: parseInt(ao.c),
      totalDevices: parseInt(td.c), pendingDevs: parseInt(pd.c),
      totalSyncs: parseInt(tc.c), pendingRequests: parseInt(pr.c),
      totalRevenue: parseFloat(tr.t), monthRevenue: parseFloat(mr.t),
      lastActivity: la?.ts,
    });
  } catch(e) { err(res, e.message, 500); }
});

// ── Revenue ───────────────────────────────────────────────────
app.get('/api/master/revenue', authMaster, async (req, res) => {
  try {
    const byFeature = await qAll(`SELECT feature_key, COUNT(*) as count, SUM(amount_kes) as total FROM payments WHERE feature_key IS NOT NULL GROUP BY feature_key ORDER BY total DESC`);
    const byOwner   = await qAll(`SELECT p.owner_id, o.business_name, o.email, COUNT(*) as payments, SUM(p.amount_kes) as total FROM payments p JOIN owners o ON p.owner_id=o.id GROUP BY p.owner_id,o.business_name,o.email ORDER BY total DESC LIMIT 10`);
    const monthly   = await qAll(`SELECT TO_CHAR(created_at,'YYYY-MM') as month, SUM(amount_kes) as total FROM payments GROUP BY month ORDER BY month DESC LIMIT 12`);
    const subCount  = await qOne("SELECT COUNT(*) as c FROM subscriptions WHERE status='ACTIVE'");
    const mrr       = await qOne("SELECT COALESCE(SUM(price_kes),0) as t FROM subscriptions WHERE status='ACTIVE'");
    ok(res, { byFeature, byOwner, monthly, activeSubCount: parseInt(subCount.c), mrr: parseFloat(mrr.t) });
  } catch(e) { err(res, e.message, 500); }
});

// ── API Keys ──────────────────────────────────────────────────
app.get('/api/master/api-keys', authSuper, async (req, res) => {
  ok(res, await qAll('SELECT id,label,key_value,created_at,last_used,active FROM api_keys ORDER BY created_at DESC'));
});
app.post('/api/master/api-keys', authSuper, async (req, res) => {
  const { label } = req.body;
  if (!label) return err(res, 'Label required');
  const kv = genApiKey();
  const id = await qInsert('INSERT INTO api_keys(key_value,label,created_by) VALUES($1,$2,$3)', [kv, label, req.master.id]);
  await audit(req.master.email, 'API_KEY_CREATE', label, null, req.ip);
  ok(res, { id, key_value: kv, label }, "Key created — save it now");
});
app.delete('/api/master/api-keys/:id', authSuper, async (req, res) => {
  await q('UPDATE api_keys SET active=0 WHERE id=$1', [parseInt(req.params.id)]);
  await audit(req.master.email, 'API_KEY_REVOKE', req.params.id, null, req.ip);
  ok(res, null, 'Key revoked');
});

// ── Owners ────────────────────────────────────────────────────
app.get('/api/master/owners', authMaster, async (req, res) => {
  try {
    const owners = await qAll(`
      SELECT o.*,
        (SELECT COUNT(*) FROM shops s WHERE s.owner_id=o.id) as shop_count,
        (SELECT COUNT(*) FROM subscriptions sub WHERE sub.owner_id=o.id AND sub.status='ACTIVE') as active_subs,
        (SELECT COALESCE(SUM(amount_kes),0) FROM payments p WHERE p.owner_id=o.id) as total_paid,
        (SELECT COUNT(*) FROM feature_requests fr WHERE fr.owner_id=o.id AND fr.status='PENDING') as pending_requests
      FROM owners o ORDER BY o.created_at DESC`);
    ok(res, owners);
  } catch(e) { err(res, e.message, 500); }
});
app.post('/api/master/owners', authMaster, async (req, res) => {
  try {
    const { email, password, name, business_name, phone, kra_pin, notes } = req.body;
    if (!email || !password || !name || !business_name) return err(res, 'email, password, name, business_name required');
    const id = await qInsert('INSERT INTO owners(email,password,name,business_name,phone,kra_pin,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [email, bcrypt.hashSync(password, 10), name, business_name, phone||null, kra_pin||null, notes||null, req.master.id]);
    await audit(req.master.email, 'OWNER_CREATE', email, business_name, req.ip);
    ok(res, { id }, 'Owner account created');
  } catch(e) { if (e.code === '23505') return err(res, 'Email already exists'); err(res, e.message, 500); }
});
app.put('/api/master/owners/:id', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const o  = await qOne('SELECT * FROM owners WHERE id=$1', [id]);
    if (!o) return err(res, 'Not found', 404);
    const { name, business_name, phone, kra_pin, status, notes, password } = req.body;
    await q('UPDATE owners SET name=COALESCE($1,name), business_name=COALESCE($2,business_name), phone=$3, kra_pin=$4, status=COALESCE($5,status), notes=$6 WHERE id=$7',
      [name, business_name, phone, kra_pin, status, notes, id]);
    // Update password separately if provided
    if (password && password.trim().length >= 8) {
      await q('UPDATE owners SET password=$1 WHERE id=$2', [bcrypt.hashSync(password.trim(), 10), id]);
    }
    if (status === 'SUSPENDED' && o.status !== 'SUSPENDED') {
      await q("UPDATE shops SET status='SUSPENDED' WHERE owner_id=$1", [id]);
      const shops = await qAll('SELECT id FROM shops WHERE owner_id=$1', [id]);
      shops.forEach(s => broadcastToShop(s.id, 'remote_command', { command:'SHOP_SUSPENDED', payload:{ message:'Account suspended. Contact support.' } }));
    }
    await audit(req.master.email, 'OWNER_UPDATE', o.email, `status:${status}${password?',password_changed':''}`, req.ip);
    ok(res, null, 'Updated');
  } catch(e) { err(res, e.message, 500); }
});
app.delete('/api/master/owners/:id', authSuper, async (req, res) => {
  const o = await qOne('SELECT * FROM owners WHERE id=$1', [parseInt(req.params.id)]);
  if (!o) return err(res, 'Not found', 404);
  await q('DELETE FROM owners WHERE id=$1', [o.id]);
  await audit(req.master.email, 'OWNER_DELETE', o.email, null, req.ip);
  ok(res, null, 'Deleted');
});
app.post('/api/master/owners/:id/reset-password', authMaster, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) return err(res, 'Min 8 characters');
  await q('UPDATE owners SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), parseInt(req.params.id)]);
  ok(res, null, 'Password reset');
});

// ── Feature Catalog ───────────────────────────────────────────
app.get('/api/master/features/catalog', authMaster, async (req, res) => {
  ok(res, await qAll('SELECT * FROM feature_catalog ORDER BY sort_order ASC'));
});
app.post('/api/master/features/catalog', authMaster, async (req, res) => {
  try {
    const { key, name, description, price_kes, category, sort_order } = req.body;
    if (!key || !name) return err(res, 'key and name required');
    const id = await qInsert('INSERT INTO feature_catalog(key,name,description,price_kes,category,sort_order) VALUES($1,$2,$3,$4,$5,$6)',
      [key, name, description||null, price_kes||0, category||'general', sort_order||99]);
    await audit(req.master.email, 'FEATURE_CREATE', key, `price:${price_kes}`, req.ip);
    ok(res, { id }, 'Feature created');
  } catch(e) { if (e.code === '23505') return err(res, 'Feature key already exists'); err(res, e.message, 500); }
});
app.put('/api/master/features/catalog/:key', authMaster, async (req, res) => {
  const { name, description, price_kes, category, active, sort_order } = req.body;
  await q('UPDATE feature_catalog SET name=COALESCE($1,name), description=$2, price_kes=COALESCE($3,price_kes), category=COALESCE($4,category), active=COALESCE($5,active), sort_order=COALESCE($6,sort_order) WHERE key=$7',
    [name, description, price_kes, category, active, sort_order, req.params.key]);
  await audit(req.master.email, 'FEATURE_UPDATE', req.params.key, `price:${price_kes}`, req.ip);
  ok(res, null, 'Updated');
});

// ── Feature Requests ──────────────────────────────────────────
app.get('/api/master/features/requests', authMaster, async (req, res) => {
  try {
    const status = req.query.status || null;
    let text = `SELECT fr.*, o.business_name, o.email as owner_email, s.name as shop_name FROM feature_requests fr JOIN owners o ON fr.owner_id=o.id LEFT JOIN shops s ON fr.shop_id=s.id`;
    const rows = status ? await qAll(text + ' WHERE fr.status=$1 ORDER BY fr.created_at DESC', [status]) : await qAll(text + ' ORDER BY fr.created_at DESC');
    ok(res, rows);
  } catch(e) { err(res, e.message, 500); }
});
app.post('/api/master/features/requests/:id/approve', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { price_kes, expires_days } = req.body;
    const fr = await qOne('SELECT * FROM feature_requests WHERE id=$1', [id]);
    if (!fr) return err(res, 'Request not found', 404);
    if (fr.status !== 'PENDING') return err(res, 'Already processed');
    const expiresAt = expires_days ? new Date(Date.now() + parseInt(expires_days)*86400000) : null;
    await q(`INSERT INTO subscriptions(owner_id,shop_id,feature_key,status,price_kes,expires_at) VALUES($1,$2,$3,'ACTIVE',$4,$5)
             ON CONFLICT(owner_id,shop_id,feature_key) DO UPDATE SET status='ACTIVE',price_kes=EXCLUDED.price_kes,expires_at=EXCLUDED.expires_at,renewed_at=NOW()`,
      [fr.owner_id, fr.shop_id||null, fr.feature_key, price_kes||0, expiresAt]);
    await q('UPDATE feature_requests SET status=$1,price_kes=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$4', ['APPROVED', price_kes||0, req.master.id, id]);
    if (fr.shop_id) {
      const shop = await qOne('SELECT * FROM shops WHERE id=$1', [fr.shop_id]);
      if (shop) {
        let feats; try { feats = JSON.parse(shop.features); } catch(e) { feats = {}; }
        feats[fr.feature_key] = true;
        await q('UPDATE shops SET features=$1 WHERE id=$2', [JSON.stringify(feats), fr.shop_id]);
        broadcastToShop(fr.shop_id, 'features_updated', { features: feats });
      }
    }
    notifyOwner(fr.owner_id, 'feature_approved', { feature_key: fr.feature_key, feature_name: fr.feature_name, price_kes: price_kes||0, expires_at: expiresAt });
    await audit(req.master.email, 'REQUEST_APPROVE', fr.feature_name, `owner:${fr.owner_id} price:${price_kes}`, req.ip);
    ok(res, null, 'Approved and feature activated');
  } catch(e) { err(res, e.message, 500); }
});
app.post('/api/master/features/requests/:id/reject', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    const fr = await qOne('SELECT * FROM feature_requests WHERE id=$1', [id]);
    if (!fr) return err(res, 'Not found', 404);
    await q('UPDATE feature_requests SET status=$1, reject_reason=$2, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4', ['REJECTED', reason||null, req.master.id, id]);
    notifyOwner(fr.owner_id, 'feature_rejected', { feature_key: fr.feature_key, feature_name: fr.feature_name, reason });
    await audit(req.master.email, 'REQUEST_REJECT', fr.feature_name, `reason:${reason}`, req.ip);
    ok(res, null, 'Rejected');
  } catch(e) { err(res, e.message, 500); }
});

// ── Subscriptions ─────────────────────────────────────────────
app.get('/api/master/subscriptions', authMaster, async (req, res) => {
  ok(res, await qAll(`SELECT sub.*, o.business_name, o.email as owner_email, s.name as shop_name, fc.name as feature_name, fc.category FROM subscriptions sub JOIN owners o ON sub.owner_id=o.id LEFT JOIN shops s ON sub.shop_id=s.id JOIN feature_catalog fc ON sub.feature_key=fc.key ORDER BY sub.started_at DESC`));
});

// ── Payments ──────────────────────────────────────────────────
app.get('/api/master/payments', authMaster, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||100, 500);
  ok(res, await qAll(`SELECT p.*, o.business_name, o.email as owner_email, s.name as shop_name FROM payments p JOIN owners o ON p.owner_id=o.id LEFT JOIN shops s ON p.shop_id=s.id ORDER BY p.created_at DESC LIMIT $1`, [limit]));
});
app.post('/api/master/payments', authMaster, async (req, res) => {
  try {
    const { owner_id, shop_id, feature_key, amount_kes, method, reference, description } = req.body;
    if (!owner_id || !amount_kes) return err(res, 'owner_id and amount_kes required');
    const id = await qInsert('INSERT INTO payments(owner_id,shop_id,feature_key,amount_kes,method,reference,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [owner_id, shop_id||null, feature_key||null, amount_kes, method||'MANUAL', reference||null, description||null, req.master.id]);
    await audit(req.master.email, 'PAYMENT_RECORD', `owner:${owner_id}`, `KES ${amount_kes}`, req.ip);
    ok(res, { id }, 'Payment recorded');
  } catch(e) { err(res, e.message, 500); }
});

// ── Shops (master) ────────────────────────────────────────────
app.get('/api/master/shops', authMaster, async (req, res) => {
  try {
    const shops = await qAll(`
      SELECT s.*, o.business_name as owner_name, o.email as owner_email,
        (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='APPROVED') AS device_count,
        (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='PENDING')  AS pending_devices,
        (SELECT MAX(d.last_seen)  FROM devices d      WHERE d.shop_id=s.id) AS last_activity,
        (SELECT MAX(b.synced_at)  FROM cloud_backups b WHERE b.shop_id=s.id) AS last_sync
      FROM shops s LEFT JOIN owners o ON s.owner_id=o.id ORDER BY s.created_at DESC`);
    shops.forEach(s => { try { s.features = JSON.parse(s.features); } catch(e) { s.features = {}; } });
    ok(res, shops);
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/master/shops/:id', authMaster, async (req, res) => {
  const s = await qOne('SELECT s.*, o.business_name as owner_name FROM shops s LEFT JOIN owners o ON s.owner_id=o.id WHERE s.id=$1', [parseInt(req.params.id)]);
  if (!s) return err(res, 'Not found', 404);
  try { s.features = JSON.parse(s.features); } catch(e) { s.features = {}; }
  ok(res, s);
});
app.post('/api/master/shops', authMaster, async (req, res) => {
  try {
    const { name, location, phone, email, kra_pin, plan, expires_at, monthly_fee, owner_id } = req.body;
    if (!name) return err(res, 'Shop name required');
    const lk = genLicense();
    const feats = { mpesa:plan==='PRO'||plan==='ENTERPRISE', etims:plan==='ENTERPRISE', multi_cashier:true, reports:plan!=='BASIC', payroll:plan==='ENTERPRISE', credit:plan!=='BASIC', repair:plan==='ENTERPRISE', stocktake:true, analytics:plan!=='BASIC' };
    const id = await qInsert('INSERT INTO shops(name,location,phone,email,kra_pin,license_key,plan,features,expires_at,monthly_fee,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [name, location||null, phone||null, email||null, kra_pin||null, lk, plan||'BASIC', JSON.stringify(feats), expires_at||null, monthly_fee||0, owner_id||null]);
    await audit(req.master.email, 'SHOP_CREATE', name, `plan:${plan}`, req.ip);
    const shop = await qOne('SELECT * FROM shops WHERE id=$1', [id]);
    try { shop.features = JSON.parse(shop.features); } catch(e) {}
    ok(res, shop, 'Shop created');
  } catch(e) { err(res, e.message, 500); }
});
app.put('/api/master/shops/:id', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const s  = await qOne('SELECT * FROM shops WHERE id=$1', [id]);
    if (!s) return err(res, 'Not found', 404);
    const { name, location, phone, email, kra_pin, plan, status, features, expires_at, monthly_fee, owner_id } = req.body;
    await q('UPDATE shops SET name=$1,location=$2,phone=$3,email=$4,kra_pin=$5,plan=$6,status=$7,features=$8,expires_at=$9,monthly_fee=$10,owner_id=$11 WHERE id=$12',
      [name||s.name, location, phone, email, kra_pin, plan||s.plan, status||s.status, features?JSON.stringify(features):s.features, expires_at, monthly_fee??s.monthly_fee, owner_id??s.owner_id, id]);
    if (status === 'SUSPENDED' && s.status !== 'SUSPENDED') broadcastToShop(id, 'remote_command', { command:'SHOP_SUSPENDED', payload:{ message:'Account suspended.' } });
    await audit(req.master.email, 'SHOP_UPDATE', s.name, `status:${status}`, req.ip);
    ok(res, null, 'Updated');
  } catch(e) { err(res, e.message, 500); }
});
app.delete('/api/master/shops/:id', authSuper, async (req, res) => {
  const s = await qOne('SELECT * FROM shops WHERE id=$1', [parseInt(req.params.id)]);
  if (!s) return err(res, 'Not found', 404);
  await q('DELETE FROM shops WHERE id=$1', [s.id]);
  await audit(req.master.email, 'SHOP_DELETE', s.name, null, req.ip);
  ok(res, null, 'Deleted');
});
app.post('/api/master/shops/:id/features', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const s  = await qOne('SELECT * FROM shops WHERE id=$1', [id]);
    if (!s) return err(res, 'Not found', 404);
    let feats; try { feats = JSON.parse(s.features); } catch(e) { feats = {}; }
    Object.assign(feats, req.body);
    await q('UPDATE shops SET features=$1 WHERE id=$2', [JSON.stringify(feats), id]);
    broadcastToShop(id, 'features_updated', { features: feats });
    await audit(req.master.email, 'FEATURES_UPDATE', s.name, JSON.stringify(req.body), req.ip);
    ok(res, feats, 'Features updated and pushed');
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/master/shops/:id/stats', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);
    let stats = { total_sales:0, total_revenue:0, today_sales:0, today_revenue:0, month_sales:0, month_revenue:0, daily_revenue:{} };
    for (let i=6; i>=0; i--) { const d=new Date(); d.setDate(d.getDate()-i); stats.daily_revenue[d.toISOString().split('T')[0]]=0; }
    const backup = await qOne("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [id]);
    if (backup) { try {
      const inv = JSON.parse(backup.data);
      stats.total_sales = inv.length;
      stats.total_revenue = inv.reduce((s,i) => s+(i.total||i.grand_total||0), 0);
      inv.filter(i => (i.created_at||i.date||'').startsWith(today)).forEach(i => { stats.today_sales++; stats.today_revenue+=(i.total||i.grand_total||0); });
      inv.filter(i => (i.created_at||i.date||'').startsWith(thisMonth)).forEach(i => { stats.month_sales++; stats.month_revenue+=(i.total||i.grand_total||0); });
      for (const i of inv) { const d=(i.created_at||i.date||'').split('T')[0]; if(stats.daily_revenue[d]!==undefined) stats.daily_revenue[d]+=(i.total||i.grand_total||0); }
    } catch(e) {} }
    const dc = await qOne("SELECT COUNT(*) as c FROM devices WHERE shop_id=$1 AND status='APPROVED'", [id]);
    const ls = await qOne('SELECT MAX(synced_at) as ts FROM cloud_backups WHERE shop_id=$1', [id]);
    stats.device_count = parseInt(dc.c); stats.last_sync = ls?.ts;
    ok(res, stats);
  } catch(e) { err(res, e.message, 500); }
});

// ── Devices ───────────────────────────────────────────────────
app.get('/api/master/devices', authMaster, async (req, res) => {
  ok(res, await qAll(`SELECT d.*, s.name AS shop_name, o.business_name as owner_name FROM devices d JOIN shops s ON d.shop_id=s.id LEFT JOIN owners o ON s.owner_id=o.id ORDER BY d.registered_at DESC`));
});
app.get('/api/master/devices/pending', authMaster, async (req, res) => {
  ok(res, await qAll(`SELECT d.*, s.name AS shop_name, s.license_key, o.business_name as owner_name FROM devices d JOIN shops s ON d.shop_id=s.id LEFT JOIN owners o ON s.owner_id=o.id WHERE d.status='PENDING' ORDER BY d.registered_at DESC`));
});
app.get('/api/master/shops/:id/devices', authMaster, async (req, res) => {
  ok(res, await qAll('SELECT * FROM devices WHERE shop_id=$1 ORDER BY registered_at DESC', [parseInt(req.params.id)]));
});
app.post('/api/master/devices/:deviceId/approve', authMaster, async (req, res) => {
  const { deviceId } = req.params;
  const d = await qOne('SELECT * FROM devices WHERE device_id=$1', [deviceId]);
  if (!d) return err(res, 'Not found', 404);
  await q('UPDATE devices SET status=$1, approved_at=NOW(), approved_by=$2 WHERE device_id=$3', ['APPROVED', req.master.id, deviceId]);
  broadcastToDevice(deviceId, 'device_approved', { device_id: deviceId });
  io.to('admin_room').emit('device_status_changed', { device_id: deviceId, status: 'APPROVED' });
  await audit(req.master.email, 'DEVICE_APPROVE', deviceId, d.name, req.ip);
  ok(res, null, 'Device approved');
});
app.post('/api/master/devices/:deviceId/block', authMaster, async (req, res) => {
  const { deviceId } = req.params;
  await q("UPDATE devices SET status='BLOCKED' WHERE device_id=$1", [deviceId]);
  broadcastToDevice(deviceId, 'device_blocked', { message: 'Blocked by admin' });
  await audit(req.master.email, 'DEVICE_BLOCK', deviceId, null, req.ip);
  ok(res, null, 'Blocked');
});
app.delete('/api/master/devices/:deviceId', authMaster, async (req, res) => {
  await q('DELETE FROM devices WHERE device_id=$1', [req.params.deviceId]);
  await audit(req.master.email, 'DEVICE_DELETE', req.params.deviceId, null, req.ip);
  ok(res, null, 'Removed');
});

// ── Remote Commands ───────────────────────────────────────────
app.post('/api/master/shops/:id/command', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const { command, device_id, payload } = req.body;
  const valid = ['LOCK_POS','UNLOCK_POS','FORCE_LOGOUT','RELOAD_APP','MESSAGE','SHOP_SUSPENDED'];
  if (!valid.includes(command)) return err(res, 'Invalid command');
  await q('INSERT INTO remote_commands(shop_id,device_id,command,payload,issued_by) VALUES($1,$2,$3,$4,$5)',
    [id, device_id||null, command, JSON.stringify(payload||{}), req.master.id]);
  if (device_id) broadcastToDevice(device_id, 'remote_command', { command, payload: payload||{} });
  else broadcastToShop(id, 'remote_command', { command, payload: payload||{} });
  await audit(req.master.email, 'REMOTE_CMD', command, `shop:${id}`, req.ip);
  ok(res, null, `Command ${command} sent`);
});

// ── Audit ─────────────────────────────────────────────────────
app.get('/api/master/audit', authMaster, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||100, 500);
  ok(res, await qAll('SELECT * FROM server_audit ORDER BY ts DESC LIMIT $1', [limit]));
});

// ── Master Users ──────────────────────────────────────────────
app.get('/api/master/users', authSuper, async (req, res) => {
  ok(res, await qAll('SELECT id,email,name,role,active,created_at,last_login FROM master_users ORDER BY created_at DESC'));
});
app.post('/api/master/users', authSuper, async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) return err(res, 'email, password, name required');
    const id = await qInsert('INSERT INTO master_users(email,password,name,role) VALUES($1,$2,$3,$4)', [email, bcrypt.hashSync(password, 10), name, role||'ADMIN']);
    await audit(req.master.email, 'MASTER_USER_CREATE', email, null, req.ip);
    ok(res, { id }, 'Admin user created');
  } catch(e) { if (e.code === '23505') return err(res, 'Email already exists'); err(res, e.message, 500); }
});

// ══════════════════════════════════════════════════════════════
//  OWNER API
// ══════════════════════════════════════════════════════════════

app.post('/api/owner/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return err(res, 'Email and password required');
    const o = await qOne("SELECT * FROM owners WHERE email=$1 AND status!='DELETED'", [email]);
    if (!o || !bcrypt.compareSync(password, o.password)) { await audit(email,'OWNER_LOGIN_FAIL',null,null,req.ip); return err(res, 'Invalid credentials', 401); }
    if (o.status === 'SUSPENDED') return err(res, 'Account suspended. Contact support.', 403);
    await q('UPDATE owners SET last_login=NOW() WHERE id=$1', [o.id]);
    await audit(o.email, 'OWNER_LOGIN', null, null, req.ip);
    const token = jwt.sign({ id:o.id, email:o.email, type:'owner', name:o.name, business:o.business_name }, JWT_SECRET, { expiresIn: JWT_EXP });
    ok(res, { token, owner: { id:o.id, email:o.email, name:o.name, business_name:o.business_name } });
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/owner/me', authOwner, async (req, res) => {
  const o = req.owner;
  ok(res, { id:o.id, email:o.email, name:o.name, business_name:o.business_name, phone:o.phone, kra_pin:o.kra_pin, created_at:o.created_at, last_login:o.last_login });
});
app.post('/api/owner/change-password', authOwner, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return err(res, 'Both passwords required');
  if (new_password.length < 8) return err(res, 'Min 8 characters');
  if (!bcrypt.compareSync(current_password, req.owner.password)) return err(res, 'Wrong current password');
  await q('UPDATE owners SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.owner.id]);
  ok(res, null, 'Password changed');
});
app.get('/api/owner/dashboard', authOwner, async (req, res) => {
  try {
    const ownerId = req.owner.id;
    const shops   = await qAll('SELECT id FROM shops WHERE owner_id=$1', [ownerId]);
    const shopIds = shops.map(s => s.id);
    const today   = new Date().toISOString().split('T')[0];
    let todaySales=0, todayRevenue=0, totalSales=0;
    for (const shopId of shopIds) {
      const backup = await qOne("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [shopId]);
      if (backup) { try {
        const inv = JSON.parse(backup.data);
        totalSales += inv.length;
        inv.filter(i => (i.created_at||i.date||'').startsWith(today)).forEach(i => { todaySales++; todayRevenue+=(i.total||i.grand_total||0); });
      } catch(e) {} }
    }
    const as = await qOne("SELECT COUNT(*) as c FROM subscriptions WHERE owner_id=$1 AND status='ACTIVE'", [ownerId]);
    const pr = await qOne("SELECT COUNT(*) as c FROM feature_requests WHERE owner_id=$1 AND status='PENDING'", [ownerId]);
    let td = { c: 0 };
    if (shopIds.length) {
      td = await qOne(`SELECT COUNT(*) as c FROM devices WHERE shop_id = ANY($1) AND status='APPROVED'`, [shopIds]);
    }
    ok(res, { todaySales, todayRevenue, totalSales, activeSubs: parseInt(as.c), pendingReqs: parseInt(pr.c), totalDevices: parseInt(td.c), shopCount: shops.length });
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/owner/shops', authOwner, async (req, res) => {
  try {
    const shops = await qAll(`SELECT s.*,
      (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='APPROVED') AS device_count,
      (SELECT MAX(d.last_seen)  FROM devices d      WHERE d.shop_id=s.id) AS last_activity,
      (SELECT MAX(b.synced_at)  FROM cloud_backups b WHERE b.shop_id=s.id) AS last_sync
      FROM shops s WHERE s.owner_id=$1 ORDER BY s.created_at DESC`, [req.owner.id]);
    shops.forEach(s => { try { s.features = JSON.parse(s.features); } catch(e) { s.features = {}; } });
    ok(res, shops);
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/owner/shops/:id/stats', authOwner, async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const shop = await qOne('SELECT * FROM shops WHERE id=$1 AND owner_id=$2', [id, req.owner.id]);
    if (!shop) return err(res, 'Not found or not yours', 404);
    const today = new Date().toISOString().split('T')[0];
    const thisMonth = new Date().toISOString().slice(0, 7);
    let stats = { total_sales:0, total_revenue:0, today_sales:0, today_revenue:0, month_sales:0, month_revenue:0, daily_revenue:{} };
    for (let i=6; i>=0; i--) { const d=new Date(); d.setDate(d.getDate()-i); stats.daily_revenue[d.toISOString().split('T')[0]]=0; }
    const backup = await qOne("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [id]);
    if (backup) { try {
      const inv = JSON.parse(backup.data);
      stats.total_sales = inv.length; stats.total_revenue = inv.reduce((s,i)=>s+(i.total||i.grand_total||0),0);
      inv.filter(i=>(i.created_at||i.date||'').startsWith(today)).forEach(i=>{stats.today_sales++;stats.today_revenue+=(i.total||i.grand_total||0);});
      inv.filter(i=>(i.created_at||i.date||'').startsWith(thisMonth)).forEach(i=>{stats.month_sales++;stats.month_revenue+=(i.total||i.grand_total||0);});
      for (const i of inv){const d=(i.created_at||i.date||'').split('T')[0];if(stats.daily_revenue[d]!==undefined)stats.daily_revenue[d]+=(i.total||i.grand_total||0);}
    } catch(e) {} }
    const ls = await qOne('SELECT MAX(synced_at) as ts FROM cloud_backups WHERE shop_id=$1', [id]);
    stats.last_sync = ls?.ts;
    ok(res, stats);
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/owner/marketplace', authOwner, async (req, res) => {
  try {
    const catalog    = await qAll("SELECT * FROM feature_catalog WHERE active=1 ORDER BY sort_order ASC");
    const activeSubs = await qAll("SELECT feature_key, shop_id, status, expires_at FROM subscriptions WHERE owner_id=$1 AND status='ACTIVE'", [req.owner.id]);
    const pendingReqs= await qAll("SELECT feature_key, shop_id, status FROM feature_requests WHERE owner_id=$1 AND status='PENDING'", [req.owner.id]);
    const subMap = {}; activeSubs.forEach(s => { subMap[s.feature_key+(s.shop_id||'')] = { status:s.status, expires_at:s.expires_at }; });
    const reqMap = {}; pendingReqs.forEach(r => { reqMap[r.feature_key+(r.shop_id||'')] = 'PENDING'; });
    ok(res, catalog.map(f => ({ ...f, subscription: subMap[f.key+'']||subMap[f.key+'null']||null, request_status: reqMap[f.key+'']||reqMap[f.key+'null']||null })));
  } catch(e) { err(res, e.message, 500); }
});
app.post('/api/owner/request-feature', authOwner, async (req, res) => {
  try {
    const { feature_key, shop_id, message } = req.body;
    if (!feature_key) return err(res, 'feature_key required');
    const feat = await qOne("SELECT * FROM feature_catalog WHERE key=$1 AND active=1", [feature_key]);
    if (!feat) return err(res, 'Feature not found');
    if (shop_id) { const shop = await qOne('SELECT * FROM shops WHERE id=$1 AND owner_id=$2', [shop_id, req.owner.id]); if (!shop) return err(res, 'Shop not yours', 403); }
    const existing = await qOne("SELECT * FROM feature_requests WHERE owner_id=$1 AND feature_key=$2 AND shop_id IS NOT DISTINCT FROM $3 AND status='PENDING'", [req.owner.id, feature_key, shop_id||null]);
    if (existing) return err(res, 'You already have a pending request for this feature');
    const id = await qInsert('INSERT INTO feature_requests(owner_id,shop_id,feature_key,feature_name,message,price_kes) VALUES($1,$2,$3,$4,$5,$6)',
      [req.owner.id, shop_id||null, feature_key, feat.name, message||null, feat.price_kes]);
    io.to('admin_room').emit('new_feature_request', { id, feature_name: feat.name, business_name: req.owner.business_name, owner_id: req.owner.id });
    await audit(req.owner.email, 'FEATURE_REQUEST', feature_key, `shop:${shop_id}`, req.ip);
    ok(res, { id }, 'Request submitted. We will review it shortly.');
  } catch(e) { err(res, e.message, 500); }
});
app.get('/api/owner/subscriptions', authOwner, async (req, res) => {
  ok(res, await qAll(`SELECT sub.*, fc.name as feature_name, fc.description, fc.category, s.name as shop_name FROM subscriptions sub JOIN feature_catalog fc ON sub.feature_key=fc.key LEFT JOIN shops s ON sub.shop_id=s.id WHERE sub.owner_id=$1 ORDER BY sub.started_at DESC`, [req.owner.id]));
});
app.get('/api/owner/requests', authOwner, async (req, res) => {
  ok(res, await qAll(`SELECT fr.*, s.name as shop_name FROM feature_requests fr LEFT JOIN shops s ON fr.shop_id=s.id WHERE fr.owner_id=$1 ORDER BY fr.created_at DESC`, [req.owner.id]));
});
app.get('/api/owner/payments', authOwner, async (req, res) => {
  ok(res, await qAll('SELECT p.*, s.name as shop_name FROM payments p LEFT JOIN shops s ON p.shop_id=s.id WHERE p.owner_id=$1 ORDER BY p.created_at DESC', [req.owner.id]));
});

// ══════════════════════════════════════════════════════════════
//  POS DEVICE API
// ══════════════════════════════════════════════════════════════

app.post('/api/pos/register', async (req, res) => {
  try {
    const { license_key, device_id, device_name, device_type, os, browser } = req.body;
    if (!license_key || !device_id) return err(res, 'license_key and device_id required');
    const shop = await qOne("SELECT * FROM shops WHERE license_key=$1 AND status!='SUSPENDED'", [license_key]);
    if (!shop) return err(res, 'Invalid or suspended license key', 403);
    const existing = await qOne('SELECT * FROM devices WHERE device_id=$1', [device_id]);
    if (existing) {
      if (existing.status === 'BLOCKED') return err(res, 'DEVICE_BLOCKED', 403);
      await q('UPDATE devices SET name=$1, type=$2, os=$3, browser=$4, ip_address=$5, last_seen=NOW() WHERE device_id=$6',
        [device_name||existing.name, device_type||existing.type, os, browser, req.ip, device_id]);
      const token = jwt.sign({ type:'device', device_id, shop_id: shop.id }, JWT_SECRET, { expiresIn: JWT_EXP });
      return ok(res, { device_token: token, device_status: existing.status, shop: { id:shop.id, name:shop.name, plan:shop.plan }, features: JSON.parse(shop.features||'{}') });
    }
    const count = await qOne("SELECT COUNT(*) as c FROM devices WHERE shop_id=$1 AND status='APPROVED'", [shop.id]);
    const status = parseInt(count.c) === 0 ? 'APPROVED' : 'PENDING';
    await q('INSERT INTO devices(device_id,shop_id,name,type,os,browser,ip_address,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [device_id, shop.id, device_name||'New Device', device_type||'phone', os, browser, req.ip, status]);
    if (status === 'APPROVED') await q('UPDATE devices SET approved_at=NOW() WHERE device_id=$1', [device_id]);
    await audit('device', 'DEVICE_REGISTER', device_id, `shop:${shop.name} status:${status}`, req.ip);
    if (status === 'PENDING') io.to('admin_room').emit('new_pending_device', { device_id, device_name, shop_name: shop.name });
    const token = jwt.sign({ type:'device', device_id, shop_id: shop.id }, JWT_SECRET, { expiresIn: JWT_EXP });
    ok(res, { device_token: token, device_status: status, shop: { id:shop.id, name:shop.name, plan:shop.plan }, features: JSON.parse(shop.features||'{}'), message: status==='PENDING'?'Waiting for admin approval':'Device approved' });
  } catch(e) { err(res, e.message, 500); }
});

app.post('/api/pos/auth', authDevice, async (req, res) => {
  const { username, role } = req.body;
  await q('UPDATE devices SET pos_user=$1 WHERE device_id=$2', [username, req.device.device_id]);
  await audit('device:'+req.device.device_id, 'POS_LOGIN', username, `role:${role}`, req.ip);
  ok(res, { features: JSON.parse(req.device.features||'{}'), shop: { id: req.device.shop_id } });
});

app.post('/api/pos/sync/push', authDevice, async (req, res) => {
  try {
    const { stores } = req.body;
    if (!stores || typeof stores !== 'object') return err(res, 'stores required');
    let total = 0;
    for (const [name, recs] of Object.entries(stores)) {
      if (!Array.isArray(recs)) continue;
      await q(`INSERT INTO cloud_backups(shop_id,device_id,store_name,data,record_count,synced_at) VALUES($1,$2,$3,$4,$5,NOW())
               ON CONFLICT(shop_id,device_id,store_name) DO UPDATE SET data=EXCLUDED.data, record_count=EXCLUDED.record_count, synced_at=NOW()`,
        [req.shopId, req.device.device_id, name, JSON.stringify(recs), recs.length]);
      total += recs.length;
    }
    ok(res, { records_synced: total, synced_at: new Date().toISOString() });
  } catch(e) { err(res, e.message, 500); }
});

app.get('/api/pos/sync/pull', authDevice, async (req, res) => {
  try {
    const shopId = req.shopId, deviceId = req.device.device_id, since = req.query.since || '1970-01-01';
    const backups = await qAll("SELECT store_name, data FROM cloud_backups WHERE shop_id=$1 AND device_id!=$2 AND synced_at>$3 ORDER BY synced_at DESC", [shopId, deviceId, since]);
    const storeMap = {};
    for (const b of backups) { if (!storeMap[b.store_name]) storeMap[b.store_name]=[]; try { storeMap[b.store_name].push(...JSON.parse(b.data)); } catch(e) {} }
    const cmds = await qAll("SELECT * FROM remote_commands WHERE shop_id=$1 AND status='PENDING' AND (device_id IS NULL OR device_id=$2) ORDER BY issued_at ASC", [shopId, deviceId]);
    if (cmds.length) {
      const ids = cmds.map(c => c.id);
      await q(`UPDATE remote_commands SET status='DELIVERED', delivered_at=NOW() WHERE id = ANY($1)`, [ids]);
    }
    ok(res, { stores: storeMap, commands: cmds.map(c => ({ command: c.command, payload: JSON.parse(c.payload||'{}') })), server_time: new Date().toISOString() });
  } catch(e) { err(res, e.message, 500); }
});

app.post('/api/pos/heartbeat', authDevice, async (req, res) => {
  try {
    const { pos_user } = req.body;
    await q('UPDATE devices SET last_seen=NOW(), pos_user=$1 WHERE device_id=$2', [pos_user||req.device.pos_user, req.device.device_id]);
    const cmds = await qAll("SELECT * FROM remote_commands WHERE shop_id=$1 AND status='PENDING' AND (device_id IS NULL OR device_id=$2)", [req.shopId, req.device.device_id]);
    ok(res, { status:'ok', commands: cmds.map(c => ({ command: c.command, payload: JSON.parse(c.payload||'{}') })) });
  } catch(e) { err(res, e.message, 500); }
});

// ── Public info ────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  try {
    const shops   = await qOne("SELECT COUNT(*) as c FROM shops WHERE status='ACTIVE'");
    const devices = await qOne("SELECT COUNT(*) as c FROM devices WHERE status='APPROVED'");
    ok(res, { server:'Distore Master Server', version:'3.0', shops: parseInt(shops.c), devices: parseInt(devices.c), time: new Date().toISOString() });
  } catch(e) { ok(res, { server:'Distore Master Server', version:'3.0', time: new Date().toISOString() }); }
});

app.get('/', (req, res) => res.send(`<!DOCTYPE html><html><head><title>Distore Server</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0b0e;color:#e8eaf0;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}.b{border:1px solid #2a2f3a;padding:40px;border-radius:12px;text-align:center;max-width:380px}h1{font-size:30px;color:#00d4aa;font-weight:900}p{color:#5a6478;font-size:12px;margin:6px 0}a{color:#00d4aa;text-decoration:none;padding:10px 20px;border:1px solid #00d4aa;border-radius:6px;display:inline-block;margin:6px 4px;font-size:12px}a:hover{background:rgba(0,212,170,.1)}</style></head><body><div class="b"><h1>DISTORE</h1><p>Master Server v3.0 · ✅ Running on Render</p><p style="font-size:10px;color:#2a2f3a;margin-top:4px">by Dilly Solutions</p><div style="margin-top:20px"><a href="/api/info">📊 API Status</a></div></div></body></html>`));


// ══════════════════════════════════════════════════════════════
//  ENFORCEMENT API
// ══════════════════════════════════════════════════════════════
app.get('/api/pos/enforcements', authDevice, async (req, res) => {
  try {
    const shopId = req.shopId, deviceId = req.device.device_id;
    const lock = await qOne(`SELECT * FROM device_locks WHERE shop_id=$1 AND locked=1 AND (device_id IS NULL OR device_id=$2) ORDER BY locked_at DESC LIMIT 1`, [shopId, deviceId]);
    const support = await qAll('SELECT key,value FROM support_config');
    const supMap = {}; support.forEach(s => { supMap[s.key] = s.value; });
    if (lock) {
      return ok(res, { pos_locked:true, lock_data:{ message:lock.message||'POS locked by administrator.', contact:lock.contact||supMap.contact||'evansmaina2026@gmail.com', phone:lock.phone||supMap.phone||'0114698986', locked_at:lock.locked_at } });
    }
    const shop = await qOne('SELECT features FROM shops WHERE id=$1', [shopId]);
    const features = JSON.parse(shop?.features || '{}');
    const modules = await qAll(`SELECT * FROM modules WHERE active=1 AND (shop_id=$1 OR shop_id IS NULL) AND (device_id=$2 OR device_id IS NULL) ORDER BY created_at ASC`, [shopId, deviceId]);
    const patches = await qAll(`SELECT * FROM patches WHERE active=1 AND (shop_id=$1 OR shop_id IS NULL) ORDER BY created_at ASC`, [shopId]);
    const cmds = await qAll(`SELECT * FROM remote_commands WHERE shop_id=$1 AND status='PENDING' AND (device_id IS NULL OR device_id=$2) ORDER BY issued_at ASC`, [shopId, deviceId]);
    if (cmds.length) await q(`UPDATE remote_commands SET status='DELIVERED',delivered_at=NOW() WHERE id=ANY($1)`, [cmds.map(c=>c.id)]);
    const newServer = await qOne("SELECT url,label FROM server_config WHERE is_active=1 ORDER BY added_at DESC LIMIT 1");
    ok(res, {
      pos_locked:false, features,
      modules: modules.map(m=>({id:m.module_id,name:m.name,html:m.html,css:m.css,js:m.js,mount_point:m.mount_point,force_reload:m.force_reload===1})),
      patches: patches.map(p=>({id:p.patch_id,type:p.type,content:p.content,selector:p.selector,action:p.action})),
      commands: cmds.map(c=>({command:c.command,payload:JSON.parse(c.payload||'{}')})),
      support_contact: supMap.contact||'evansmaina2026@gmail.com',
      support_phone:   supMap.phone||'0114698986',
      new_server_url:  newServer?.url||null, new_server_label: newServer?.label||null,
    });
  } catch(e) { err(res, e.message, 500); }
});

// Support Config
app.get('/api/master/support-config', authMaster, async (req, res) => {
  const rows = await qAll('SELECT key,value FROM support_config');
  const cfg = {}; rows.forEach(r=>{cfg[r.key]=r.value;}); ok(res, cfg);
});
app.post('/api/master/support-config', authMaster, async (req, res) => {
  const {contact,phone,name} = req.body;
  if (contact) await q(`INSERT INTO support_config(key,value) VALUES('contact',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()`, [contact]);
  if (phone)   await q(`INSERT INTO support_config(key,value) VALUES('phone',$1)   ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()`, [phone]);
  if (name)    await q(`INSERT INTO support_config(key,value) VALUES('name',$1)    ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()`, [name]);
  io.emit('support_update', {contact,phone,name});
  await audit(req.master.email,'SUPPORT_CONFIG_UPDATE',null,`contact:${contact}`,req.ip);
  ok(res, null, 'Support config updated and pushed to all devices');
});

// Device Lock/Unlock
app.post('/api/master/shops/:id/lock', authMaster, async (req, res) => {
  try {
    const shopId = parseInt(req.params.id);
    const {device_id,message,contact,phone} = req.body;
    const support = await qAll('SELECT key,value FROM support_config');
    const supMap = {}; support.forEach(s=>{supMap[s.key]=s.value;});
    const lockMsg  = message||'This POS has been locked by the administrator.';
    const lockCont = contact||supMap.contact||'evansmaina2026@gmail.com';
    const lockPhone= phone||supMap.phone||'0114698986';
    await q(`INSERT INTO device_locks(shop_id,device_id,locked,message,contact,phone,locked_by) VALUES($1,$2,1,$3,$4,$5,$6)`,
      [shopId,device_id||null,lockMsg,lockCont,lockPhone,req.master.id]);
    await q(`INSERT INTO remote_commands(shop_id,device_id,command,payload,issued_by) VALUES($1,$2,'LOCK_POS',$3,$4)`,
      [shopId,device_id||null,JSON.stringify({message:lockMsg,contact:lockCont,phone:lockPhone}),req.master.id]);
    const payload = {command:'LOCK_POS',payload:{message:lockMsg,contact:lockCont,phone:lockPhone}};
    if (device_id) broadcastToDevice(device_id,'remote_command',payload);
    else broadcastToShop(shopId,'remote_command',payload);
    await audit(req.master.email,'POS_LOCK',`shop:${shopId}`,device_id||'all',req.ip);
    ok(res,null,'Lock applied — online devices locked immediately, offline on reconnect');
  } catch(e) { err(res,e.message,500); }
});
app.post('/api/master/shops/:id/unlock', authMaster, async (req, res) => {
  try {
    const shopId = parseInt(req.params.id);
    const {device_id} = req.body;
    await q(`UPDATE device_locks SET locked=0,unlocked_at=NOW() WHERE shop_id=$1 AND locked=1 AND (device_id IS NULL OR device_id=$2)`, [shopId,device_id||null]);
    await q(`INSERT INTO remote_commands(shop_id,device_id,command,payload,issued_by) VALUES($1,$2,'UNLOCK_POS','{}' ,$3)`, [shopId,device_id||null,req.master.id]);
    if (device_id) broadcastToDevice(device_id,'remote_command',{command:'UNLOCK_POS',payload:{}});
    else broadcastToShop(shopId,'remote_command',{command:'UNLOCK_POS',payload:{}});
    await audit(req.master.email,'POS_UNLOCK',`shop:${shopId}`,device_id||'all',req.ip);
    ok(res,null,'Unlocked');
  } catch(e) { err(res,e.message,500); }
});

// Modules
app.get('/api/master/modules', authMaster, async (req, res) => {
  ok(res, await qAll(`SELECT m.*,s.name as shop_name FROM modules m LEFT JOIN shops s ON m.shop_id=s.id ORDER BY m.created_at DESC`));
});
app.post('/api/master/modules', authMaster, async (req, res) => {
  try {
    const {module_id,shop_id,device_id,name,description,html,css,js,mount_point,force_reload} = req.body;
    if (!module_id||!name) return err(res,'module_id and name required');
    await q(`INSERT INTO modules(module_id,shop_id,device_id,name,description,html,css,js,mount_point,force_reload,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT(module_id,shop_id) DO UPDATE SET name=$4,description=$5,html=$6,css=$7,js=$8,mount_point=$9,force_reload=$10,active=1`,
      [module_id,shop_id||null,device_id||null,name,description||null,html||null,css||null,js||null,mount_point||'app',force_reload?1:0,req.master.id]);
    const modPay = {id:module_id,name,html:html||null,css:css||null,js:js||null,mount_point:mount_point||'app',force_reload:!!force_reload};
    if (shop_id) { if(device_id) broadcastToDevice(device_id,'module_push',modPay); else broadcastToShop(parseInt(shop_id),'module_push',modPay); }
    else io.emit('module_push',modPay);
    await audit(req.master.email,'MODULE_PUSH',module_id,`shop:${shop_id||'all'}`,req.ip);
    ok(res,null,'Module pushed');
  } catch(e) { err(res,e.message,500); }
});
app.delete('/api/master/modules/:mid', authMaster, async (req, res) => {
  const mod = await qOne('SELECT * FROM modules WHERE module_id=$1', [req.params.mid]);
  if (!mod) return err(res,'Not found',404);
  await q('UPDATE modules SET active=0 WHERE module_id=$1', [req.params.mid]);
  const payload = {command:'REMOVE_MODULE',payload:{module_id:req.params.mid}};
  if (mod.shop_id) broadcastToShop(mod.shop_id,'remote_command',payload);
  else io.emit('remote_command',payload);
  ok(res,null,'Module removed');
});

// Patches
app.get('/api/master/patches', authMaster, async (req, res) => {
  ok(res, await qAll(`SELECT p.*,s.name as shop_name FROM patches p LEFT JOIN shops s ON p.shop_id=s.id ORDER BY p.created_at DESC`));
});
app.post('/api/master/patches', authMaster, async (req, res) => {
  try {
    const {patch_id,shop_id,name,type,content,selector,action} = req.body;
    if (!patch_id||!name||!type||!content) return err(res,'patch_id,name,type,content required');
    if (!['css','js','html'].includes(type)) return err(res,'type must be css,js,html');
    await q(`INSERT INTO patches(patch_id,shop_id,name,type,content,selector,action,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(patch_id) DO UPDATE SET name=$3,type=$4,content=$5,selector=$6,action=$7,active=1`,
      [patch_id,shop_id||null,name,type,content,selector||null,action||'append',req.master.id]);
    const patchPay = {id:patch_id,type,content,selector:selector||null,action:action||'append'};
    if (shop_id) broadcastToShop(parseInt(shop_id),'patch_push',patchPay);
    else io.emit('patch_push',patchPay);
    await audit(req.master.email,'PATCH_PUSH',patch_id,`shop:${shop_id||'all'} type:${type}`,req.ip);
    ok(res,null,'Patch pushed');
  } catch(e) { err(res,e.message,500); }
});
app.delete('/api/master/patches/:pid', authMaster, async (req, res) => {
  await q('UPDATE patches SET active=0 WHERE patch_id=$1', [req.params.pid]);
  ok(res,null,'Patch deactivated');
});

// Server Config
app.get('/api/master/server-config', authMaster, async (req, res) => {
  ok(res, await qAll('SELECT * FROM server_config ORDER BY added_at DESC'));
});
app.post('/api/master/server-config', authMaster, async (req, res) => {
  try {
    const {label,url,notes} = req.body;
    if (!label||!url) return err(res,'label and url required');
    await q(`INSERT INTO server_config(label,url,notes,added_by) VALUES($1,$2,$3,$4) ON CONFLICT(url) DO UPDATE SET label=$1,notes=$3`,
      [label,url.trim().replace(/\/$/,''),notes||null,req.master.id]);
    await audit(req.master.email,'SERVER_ADD',url,label,req.ip);
    ok(res,null,'Server added');
  } catch(e) { err(res,e.message,500); }
});
app.post('/api/master/server-config/:id/activate', authMaster, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const svr = await qOne('SELECT * FROM server_config WHERE id=$1', [id]);
    if (!svr) return err(res,'Not found',404);
    await q('UPDATE server_config SET is_active=0');
    await q('UPDATE server_config SET is_active=1 WHERE id=$1', [id]);
    io.emit('server_switch',{new_url:svr.url,label:svr.label});
    io.emit('remote_command',{command:'SWITCH_SERVER',payload:{new_url:svr.url,label:svr.label}});
    const shops = await qAll("SELECT id FROM shops WHERE status='ACTIVE'");
    for (const shop of shops) {
      await q(`INSERT INTO remote_commands(shop_id,device_id,command,payload,issued_by) VALUES($1,NULL,'SWITCH_SERVER',$2,$3)`,
        [shop.id,JSON.stringify({new_url:svr.url,label:svr.label}),req.master.id]);
    }
    await audit(req.master.email,'SERVER_ACTIVATE',svr.url,svr.label,req.ip);
    ok(res,null,`Server "${svr.label}" activated and pushed to all devices`);
  } catch(e) { err(res,e.message,500); }
});
app.delete('/api/master/server-config/:id', authMaster, async (req, res) => {
  await q('DELETE FROM server_config WHERE id=$1', [parseInt(req.params.id)]);
  ok(res,null,'Server removed');
});

// DB Export / Import
app.get('/api/master/db/export', authSuper, async (req, res) => {
  try {
    const [owners,shops,devices,feats,subs,pymnts,reqs,mods,patches,support] = await Promise.all([
      qAll('SELECT * FROM owners'),qAll('SELECT * FROM shops'),qAll('SELECT * FROM devices'),
      qAll('SELECT * FROM feature_catalog'),qAll('SELECT * FROM subscriptions'),qAll('SELECT * FROM payments'),
      qAll('SELECT * FROM feature_requests'),qAll('SELECT * FROM modules'),qAll('SELECT * FROM patches'),
      qAll('SELECT * FROM support_config'),
    ]);
    const exportData = {version:'3.0',exported_at:new Date().toISOString(),owners,shops,devices,
      feature_catalog:feats,subscriptions:subs,payments:pymnts,feature_requests:reqs,modules:mods,patches,support_config:support};
    res.setHeader('Content-Type','application/json');
    res.setHeader('Content-Disposition',`attachment; filename="distore-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify(exportData,null,2));
    await audit(req.master.email,'DB_EXPORT',null,null,req.ip);
  } catch(e) { err(res,e.message,500); }
});
app.post('/api/master/db/import', authSuper, async (req, res) => {
  try {
    const data = req.body;
    if (!data.version||!data.owners) return err(res,'Invalid export file');
    let imported = {owners:0,shops:0,features:0,subscriptions:0,payments:0};
    for (const o of (data.owners||[])) {
      try { await q(`INSERT INTO owners(email,password,name,business_name,phone,kra_pin,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(email) DO NOTHING`,
        [o.email,o.password,o.name,o.business_name,o.phone,o.kra_pin,o.status||'ACTIVE',o.created_at]); imported.owners++; } catch(e) {}
    }
    for (const f of (data.feature_catalog||[])) {
      try { await q(`INSERT INTO feature_catalog(key,name,description,price_kes,category,sort_order,active) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(key) DO NOTHING`,
        [f.key,f.name,f.description,f.price_kes,f.category,f.sort_order,f.active]); imported.features++; } catch(e) {}
    }
    for (const s of (data.shops||[])) {
      try { await q(`INSERT INTO shops(name,location,phone,email,kra_pin,license_key,status,plan,features,monthly_fee,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(license_key) DO NOTHING`,
        [s.name,s.location,s.phone,s.email,s.kra_pin,s.license_key,s.status||'ACTIVE',s.plan||'BASIC',s.features||'{}',s.monthly_fee||0,s.expires_at]); imported.shops++; } catch(e) {}
    }
    for (const sub of (data.subscriptions||[])) {
      try { await q(`INSERT INTO subscriptions(owner_id,shop_id,feature_key,status,price_kes,started_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [sub.owner_id,sub.shop_id,sub.feature_key,sub.status,sub.price_kes,sub.started_at,sub.expires_at]); imported.subscriptions++; } catch(e) {}
    }
    for (const p of (data.payments||[])) {
      try { await q(`INSERT INTO payments(owner_id,shop_id,feature_key,amount_kes,method,reference,description,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.owner_id,p.shop_id,p.feature_key,p.amount_kes,p.method,p.reference,p.description,p.created_at]); imported.payments++; } catch(e) {}
    }
    for (const sc of (data.support_config||[])) {
      try { await q(`INSERT INTO support_config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [sc.key,sc.value]); } catch(e) {}
    }
    await audit(req.master.email,'DB_IMPORT',null,JSON.stringify(imported),req.ip);
    ok(res,imported,`Imported: ${imported.owners} owners, ${imported.shops} shops, ${imported.subscriptions} subs`);
  } catch(e) { err(res,e.message,500); }
});

// ══════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════
const deviceSockets = new Map();
function broadcastToShop(shopId, event, data)    { io.to(`shop:${shopId}`).emit(event, data); }
function broadcastToDevice(deviceId, event, data) { deviceSockets.get(deviceId)?.emit(event, data); }
function notifyOwner(ownerId, event, data)         { io.to(`owner:${ownerId}`).emit(event, data); }

io.on('connection', socket => {
  let devId = null, shopId = null;

  socket.on('device_auth', async ({ device_token, license_key }) => {
    try {
      const p = jwt.verify(device_token, JWT_SECRET);
      if (p.type !== 'device') { socket.emit('auth_error', { message:'Invalid token' }); return; }
      const d = await qOne(`SELECT d.*,s.status AS shop_status,s.features,s.plan,s.name AS shop_name FROM devices d JOIN shops s ON d.shop_id=s.id WHERE d.device_id=$1 AND s.license_key=$2`, [p.device_id, license_key]);
      if (!d || d.status !== 'APPROVED') { socket.emit('auth_error', { message: d?.status==='PENDING'?'PENDING_APPROVAL':'NOT_AUTHORIZED' }); return; }
      devId = d.device_id; shopId = d.shop_id;
      socket.join(`shop:${shopId}`);
      deviceSockets.set(devId, socket);
      await q('UPDATE devices SET last_seen=NOW() WHERE device_id=$1', [devId]);
      socket.emit('auth_ok', { device_id:devId, shop_id:shopId, shop_name:d.shop_name, plan:d.plan, features:JSON.parse(d.features||'{}') });
      io.to('admin_room').emit('device_connected', { device_id:devId, device_name:d.name, shop_id:shopId, shop_name:d.shop_name });
    } catch(e) { socket.emit('auth_error', { message:'Token error' }); }
  });

  socket.on('owner_auth', ({ token }) => {
    try { const p = jwt.verify(token, JWT_SECRET); if (p.type==='owner') { socket.join(`owner:${p.id}`); socket.emit('owner_auth_ok'); } } catch(e) {}
  });

  ['SYNC_DATA','DB_CHANGE','FULL_SYNC_REQUEST','FULL_SYNC_RESPONSE'].forEach(ev => {
    socket.on(ev, data => { if (shopId) socket.to(`shop:${shopId}`).emit(ev, data); });
  });

  socket.on('admin_auth', ({ token }) => {
    try { jwt.verify(token, JWT_SECRET); socket.join('admin_room'); socket.emit('admin_auth_ok'); } catch(e) {}
  });

  socket.on('disconnect', () => {
    if (devId) { deviceSockets.delete(devId); io.to('admin_room').emit('device_disconnected', { device_id: devId }); }
  });
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
setupDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀  Distore Server v3.0 running on port ${PORT}`);
    console.log(`📊  API: /api/info`);
    console.log(`✅  Ready\n`);
  });
}).catch(e => {
  console.error('❌  Database setup failed:', e.message);
  process.exit(1);
});

process.on('SIGINT',  () => { pool.end(); console.log('\n👋'); process.exit(0); });
process.on('SIGTERM', () => { pool.end(); process.exit(0); });
