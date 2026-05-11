/**
 * ═══════════════════════════════════════════════════════════════
 *  DISTORE MASTER SERVER v3.0  — PostgreSQL Edition
 *  by Dilly Solutions
 * ═══════════════════════════════════════════════════════════════
 *
 *  Full SaaS POS backend — serves 3 apps:
 *    👑 distore-admin.html  → /api/master/*  (you)
 *    🏪 distore-owner.html  → /api/owner/*   (your clients)
 *    📱 distore-pos.html    → /api/pos/*     (cashiers)
 *
 *  USAGE:
 *    node distore-server.js
 *    PORT=4000 node distore-server.js
 *    node distore-server.js --reset-admin
 *    node distore-server.js --create-owner "Name" email password
 *
 *  ENV VARS (set these on Render):
 *    DATABASE_URL=postgresql://...   ← Render provides this automatically
 *    PORT=3000
 *    JWT_SECRET=your-secret
 *    ADMIN_EMAIL=evansmaina2026@gmail.com
 *    ADMIN_PASSWORD=Dilly@2026!
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');
const os     = require('os');

let express, socketIO, jwt, bcrypt, pg;
try { express  = require('express');        } catch(e) { die('express');        }
try { socketIO = require('socket.io');      } catch(e) { die('socket.io');      }
try { jwt      = require('jsonwebtoken');   } catch(e) { die('jsonwebtoken');   }
try { bcrypt   = require('bcryptjs');       } catch(e) { die('bcryptjs');       }
try { pg       = require('pg');             } catch(e) { die('pg');             }

function die(pkg) {
  console.error(`\n❌  Missing: ${pkg}\n   Run: npm install\n`);
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────
const PORT       = process.env.PORT           || 3000;
const JWT_SECRET = process.env.JWT_SECRET     || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL= process.env.ADMIN_EMAIL    || 'evansmaina2026@gmail.com';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'Dilly@2026!';
const JWT_EXP    = '7d';

// ── PostgreSQL Pool ───────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Shorthand helpers — mimic the synchronous SQLite API style
// q(sql, params)  → returns rows[]
// q1(sql, params) → returns first row or undefined
// qr(sql, params) → returns { rowCount, rows, lastId }
async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function q1(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}
async function qr(sql, params = []) {
  const res = await pool.query(sql, params);
  return { rowCount: res.rowCount, rows: res.rows, lastId: res.rows[0]?.id };
}

// ── Schema ────────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    -- Master admin users
    CREATE TABLE IF NOT EXISTS master_users (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'ADMIN',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ
    );

    -- API Keys
    CREATE TABLE IF NOT EXISTS api_keys (
      id         SERIAL PRIMARY KEY,
      key_value  TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      created_by INTEGER REFERENCES master_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used  TIMESTAMPTZ,
      active     INTEGER NOT NULL DEFAULT 1
    );

    -- Owner accounts
    CREATE TABLE IF NOT EXISTS owners (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password      TEXT NOT NULL,
      name          TEXT NOT NULL,
      business_name TEXT NOT NULL,
      phone         TEXT,
      kra_pin       TEXT,
      status        TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by    INTEGER REFERENCES master_users(id),
      last_login    TIMESTAMPTZ,
      notes         TEXT
    );

    -- Shops/Branches
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
      monthly_fee REAL NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ,
      owner_id    INTEGER REFERENCES owners(id) ON DELETE SET NULL
    );

    -- Feature catalog
    CREATE TABLE IF NOT EXISTS feature_catalog (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      price_kes   REAL NOT NULL DEFAULT 0,
      category    TEXT NOT NULL DEFAULT 'general',
      active      INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Subscriptions
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      shop_id      INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      feature_key  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'ACTIVE',
      price_kes    REAL NOT NULL DEFAULT 0,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ,
      renewed_at   TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      UNIQUE(owner_id, shop_id, feature_key)
    );

    -- Feature requests
    CREATE TABLE IF NOT EXISTS feature_requests (
      id            SERIAL PRIMARY KEY,
      owner_id      INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      shop_id       INTEGER REFERENCES shops(id),
      feature_key   TEXT NOT NULL,
      feature_name  TEXT NOT NULL,
      message       TEXT,
      status        TEXT NOT NULL DEFAULT 'PENDING',
      price_kes     REAL,
      reviewed_by   INTEGER REFERENCES master_users(id),
      reviewed_at   TIMESTAMPTZ,
      reject_reason TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Payments
    CREATE TABLE IF NOT EXISTS payments (
      id           SERIAL PRIMARY KEY,
      owner_id     INTEGER NOT NULL REFERENCES owners(id),
      shop_id      INTEGER REFERENCES shops(id),
      feature_key  TEXT,
      amount_kes   REAL NOT NULL,
      method       TEXT NOT NULL DEFAULT 'MANUAL',
      reference    TEXT,
      description  TEXT,
      recorded_by  INTEGER REFERENCES master_users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Devices
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
      last_seen     TIMESTAMPTZ,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at   TIMESTAMPTZ,
      approved_by   INTEGER REFERENCES master_users(id)
    );

    -- Cloud backups
    CREATE TABLE IF NOT EXISTS cloud_backups (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      device_id    TEXT NOT NULL,
      store_name   TEXT NOT NULL,
      data         TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shop_id, device_id, store_name)
    );

    -- Remote commands
    CREATE TABLE IF NOT EXISTS remote_commands (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      device_id    TEXT,
      command      TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'PENDING',
      issued_by    INTEGER REFERENCES master_users(id),
      issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );

    -- Audit log
    CREATE TABLE IF NOT EXISTS server_audit (
      id      SERIAL PRIMARY KEY,
      ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor   TEXT,
      action  TEXT NOT NULL,
      target  TEXT,
      details TEXT,
      ip      TEXT
    );

    -- Indexes
    CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_unique  ON cloud_backups(shop_id, device_id, store_name);
    CREATE INDEX IF NOT EXISTS idx_devices_shop           ON devices(shop_id);
    CREATE INDEX IF NOT EXISTS idx_commands_pending       ON remote_commands(shop_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_ts               ON server_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_subs_owner             ON subscriptions(owner_id);
    CREATE INDEX IF NOT EXISTS idx_requests_status        ON feature_requests(status);
    CREATE INDEX IF NOT EXISTS idx_payments_owner         ON payments(owner_id);
    CREATE INDEX IF NOT EXISTS idx_shops_owner            ON shops(owner_id);
  `);
}

// ── Seed data ─────────────────────────────────────────────────
async function seedData() {
  // Superadmin
  const existing = await q1('SELECT id FROM master_users WHERE role=$1', ['SUPERADMIN']);
  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    await pool.query(
      'INSERT INTO master_users(email,password,name,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [ADMIN_EMAIL, hash, 'Dilly (Superadmin)', 'SUPERADMIN']
    );
    console.log(`\n🔑  Superadmin: ${ADMIN_EMAIL}  pw: ${ADMIN_PASS}\n`);
  }

  // Feature catalog
  const seedFeatures = [
    { key:'mpesa',         name:'M-PESA Payments',      description:'Accept Lipa Na M-PESA STK Push payments at checkout',             price_kes:500,  category:'payments',   sort_order:1 },
    { key:'etims',         name:'eTIMS / KRA Tax',       description:'KRA eTIMS-compliant receipts with 16% VAT and KRA PIN',           price_kes:1000, category:'compliance', sort_order:2 },
    { key:'reports',       name:'Advanced Reports',      description:'Sales reports, profit/loss, cashier performance, export to PDF',  price_kes:300,  category:'analytics',  sort_order:3 },
    { key:'analytics',     name:'Business Analytics',    description:'Charts, trends, product performance, peak hour analysis',         price_kes:200,  category:'analytics',  sort_order:4 },
    { key:'multi_cashier', name:'Multi-Cashier',         description:'Multiple cashier accounts with individual shift tracking',        price_kes:300,  category:'operations', sort_order:5 },
    { key:'credit',        name:'Credit & Layaway',      description:'Customer credit accounts, layaway plans, debt tracking',         price_kes:400,  category:'operations', sort_order:6 },
    { key:'payroll',       name:'Staff Payroll',         description:'Kenyan payroll with PAYE, NHIF, NSSF deductions',                price_kes:500,  category:'hr',         sort_order:7 },
    { key:'repair',        name:'Repair Module',         description:'Track repair jobs, parts, labour, customer collection',          price_kes:300,  category:'operations', sort_order:8 },
    { key:'stocktake',     name:'Stock Take',            description:'Full stock count workflow with variance reports',                 price_kes:0,    category:'inventory',  sort_order:9 },
    { key:'supplier',      name:'Supplier Management',   description:'Supplier ledgers, GRN, purchase orders, credit tracking',        price_kes:200,  category:'inventory',  sort_order:10 },
  ];
  for (const f of seedFeatures) {
    await pool.query(
      `INSERT INTO feature_catalog(key,name,description,price_kes,category,sort_order)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(key) DO NOTHING`,
      [f.key, f.name, f.description, f.price_kes, f.category, f.sort_order]
    );
  }
}

// ── CLI shortcuts ─────────────────────────────────────────────
async function handleCLI() {
  if (process.argv.includes('--reset-admin')) {
    await initSchema();
    await pool.query('UPDATE master_users SET password=$1 WHERE role=$2',
      [bcrypt.hashSync(ADMIN_PASS, 10), 'SUPERADMIN']);
    console.log('✅ Admin password reset to: ' + ADMIN_PASS);
    process.exit(0);
  }

  if (process.argv.includes('--create-owner')) {
    await initSchema();
    const idx = process.argv.indexOf('--create-owner');
    const [biz, email, pass] = process.argv.slice(idx + 1, idx + 4);
    if (!biz || !email || !pass) { console.error('Usage: --create-owner "Biz Name" email password'); process.exit(1); }
    await pool.query('INSERT INTO owners(email,password,name,business_name) VALUES($1,$2,$3,$4)',
      [email, bcrypt.hashSync(pass, 10), biz, biz]);
    console.log(`✅ Owner created: ${email}`);
    process.exit(0);
  }
}

// ── Express + Socket.IO ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
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

// ── Helpers ───────────────────────────────────────────────────
const ok  = (res, data, msg = 'OK') => res.json({ success: true, msg, data });
const err = (res, msg, code = 400)  => res.status(code).json({ success: false, msg });
const genLicense = () => 'DST-' + crypto.randomBytes(6).toString('hex').toUpperCase();
const genApiKey  = () => 'dak_' + crypto.randomBytes(20).toString('hex');

async function audit(actor, action, target, details, ip) {
  try {
    await pool.query(
      'INSERT INTO server_audit(actor,action,target,details,ip) VALUES($1,$2,$3,$4,$5)',
      [actor || 'system', action, target || null, details || null, ip || null]
    );
  } catch (e) {}
}

// ── Auth Middleware ───────────────────────────────────────────
function authMaster(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return err(res, 'No token', 401);
  try { req.master = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { err(res, 'Invalid or expired token', 401); }
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
    q1('SELECT * FROM owners WHERE id=$1 AND status=$2', [p.id, 'ACTIVE'])
      .then(o => {
        if (!o) return err(res, 'Owner account not found or suspended', 401);
        req.owner = o;
        next();
      }).catch(() => err(res, 'DB error', 500));
  } catch (e) { err(res, 'Invalid or expired token', 401); }
}

function authDevice(req, res, next) {
  const token      = req.headers['x-device-token'] || req.query.device_token || '';
  const licenseKey = req.headers['x-license-key']  || req.query.license_key  || '';
  if (!token || !licenseKey) return err(res, 'Device token + license key required', 401);
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.type !== 'device') return err(res, 'Invalid token type', 401);
    q1(`SELECT d.*, s.features, s.status AS shop_status, s.plan, s.name AS shop_name
        FROM devices d JOIN shops s ON d.shop_id=s.id
        WHERE d.device_id=$1 AND s.license_key=$2`, [p.device_id, licenseKey])
      .then(d => {
        if (!d)                          return err(res, 'Device not found', 401);
        if (d.status === 'PENDING')      return err(res, 'DEVICE_PENDING: Waiting for admin approval', 403);
        if (d.status === 'BLOCKED')      return err(res, 'DEVICE_BLOCKED: This device is blocked', 403);
        if (d.shop_status === 'SUSPENDED') return err(res, 'SHOP_SUSPENDED: Shop account suspended', 403);
        req.device = d; req.shopId = d.shop_id;
        pool.query('UPDATE devices SET last_seen=NOW(),ip_address=$1 WHERE device_id=$2', [req.ip, p.device_id]);
        next();
      }).catch(() => err(res, 'DB error', 500));
  } catch (e) { err(res, 'Invalid device token', 401); }
}

// ═══════════════════════════════════════════════════════════════
//  MASTER API  (/api/master/*)
// ═══════════════════════════════════════════════════════════════

app.post('/api/master/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'Email and password required');
  const u = await q1('SELECT * FROM master_users WHERE email=$1 AND active=1', [email]);
  if (!u || !bcrypt.compareSync(password, u.password)) {
    audit(email, 'MASTER_LOGIN_FAIL', null, null, req.ip);
    return err(res, 'Invalid credentials', 401);
  }
  await pool.query('UPDATE master_users SET last_login=NOW() WHERE id=$1', [u.id]);
  audit(u.email, 'MASTER_LOGIN', null, null, req.ip);
  const token = jwt.sign({ id: u.id, email: u.email, role: u.role, name: u.name }, JWT_SECRET, { expiresIn: JWT_EXP });
  ok(res, { token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
});

app.get('/api/master/me', authMaster, async (req, res) => {
  ok(res, await q1('SELECT id,email,name,role,created_at,last_login FROM master_users WHERE id=$1', [req.master.id]));
});

app.post('/api/master/change-password', authMaster, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return err(res, 'Both passwords required');
  if (new_password.length < 8) return err(res, 'Min 8 characters');
  const u = await q1('SELECT * FROM master_users WHERE id=$1', [req.master.id]);
  if (!bcrypt.compareSync(current_password, u.password)) return err(res, 'Wrong current password');
  await pool.query('UPDATE master_users SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), u.id]);
  audit(u.email, 'PASSWORD_CHANGE', null, null, req.ip);
  ok(res, null, 'Password changed');
});

app.get('/api/master/summary', authMaster, async (req, res) => {
  const [totalRevRow, monthRevRow, pendingReqRow,
         totalShops, activeShops, totalOwners, activeOwners,
         totalDevices, pendingDevs, totalSyncs, lastActivity] = await Promise.all([
    q1('SELECT COALESCE(SUM(amount_kes),0) as t FROM payments'),
    q1("SELECT COALESCE(SUM(amount_kes),0) as t FROM payments WHERE created_at >= date_trunc('month', NOW())"),
    q1("SELECT COUNT(*) as c FROM feature_requests WHERE status='PENDING'"),
    q1('SELECT COUNT(*) as c FROM shops'),
    q1("SELECT COUNT(*) as c FROM shops WHERE status='ACTIVE'"),
    q1('SELECT COUNT(*) as c FROM owners'),
    q1("SELECT COUNT(*) as c FROM owners WHERE status='ACTIVE'"),
    q1("SELECT COUNT(*) as c FROM devices WHERE status='APPROVED'"),
    q1("SELECT COUNT(*) as c FROM devices WHERE status='PENDING'"),
    q1('SELECT COUNT(*) as c FROM cloud_backups'),
    q1('SELECT MAX(last_seen) as ts FROM devices'),
  ]);
  ok(res, {
    totalShops: +totalShops.c, activeShops: +activeShops.c,
    totalOwners: +totalOwners.c, activeOwners: +activeOwners.c,
    totalDevices: +totalDevices.c, pendingDevs: +pendingDevs.c,
    totalSyncs: +totalSyncs.c,
    pendingRequests: +pendingReqRow.c,
    totalRevenue: +totalRevRow.t,
    monthRevenue: +monthRevRow.t,
    lastActivity: lastActivity?.ts,
  });
});

app.get('/api/master/revenue', authMaster, async (req, res) => {
  const [byFeature, byOwner, monthly, activeSubCount, mrrRow] = await Promise.all([
    q(`SELECT feature_key, COUNT(*) as count, SUM(amount_kes) as total
       FROM payments WHERE feature_key IS NOT NULL
       GROUP BY feature_key ORDER BY total DESC`),
    q(`SELECT p.owner_id, o.business_name, o.email, COUNT(*) as payments, SUM(p.amount_kes) as total
       FROM payments p JOIN owners o ON p.owner_id=o.id
       GROUP BY p.owner_id,o.business_name,o.email ORDER BY total DESC LIMIT 10`),
    q(`SELECT TO_CHAR(created_at,'YYYY-MM') as month, SUM(amount_kes) as total
       FROM payments GROUP BY month ORDER BY month DESC LIMIT 12`),
    q1("SELECT COUNT(*) as c FROM subscriptions WHERE status='ACTIVE'"),
    q1("SELECT COALESCE(SUM(price_kes),0) as t FROM subscriptions WHERE status='ACTIVE'"),
  ]);
  ok(res, { byFeature, byOwner, monthly, activeSubCount: +activeSubCount.c, mrr: +mrrRow.t });
});

// API Keys
app.get('/api/master/api-keys', authSuper, async (req, res) => {
  ok(res, await q('SELECT id,label,key_value,created_at,last_used,active FROM api_keys ORDER BY created_at DESC'));
});
app.post('/api/master/api-keys', authSuper, async (req, res) => {
  const { label } = req.body;
  if (!label) return err(res, 'Label required');
  const kv = genApiKey();
  const r = await q1('INSERT INTO api_keys(key_value,label,created_by) VALUES($1,$2,$3) RETURNING id', [kv, label, req.master.id]);
  audit(req.master.email, 'API_KEY_CREATE', label, null, req.ip);
  ok(res, { id: r.id, key_value: kv, label }, 'Key created — save it now');
});
app.delete('/api/master/api-keys/:id', authSuper, async (req, res) => {
  await pool.query('UPDATE api_keys SET active=0 WHERE id=$1', [parseInt(req.params.id)]);
  audit(req.master.email, 'API_KEY_REVOKE', req.params.id, null, req.ip);
  ok(res, null, 'Key revoked');
});

// Owner management
app.get('/api/master/owners', authMaster, async (req, res) => {
  const owners = await q(`
    SELECT o.*,
      (SELECT COUNT(*) FROM shops s WHERE s.owner_id=o.id) as shop_count,
      (SELECT COUNT(*) FROM subscriptions sub WHERE sub.owner_id=o.id AND sub.status='ACTIVE') as active_subs,
      (SELECT COALESCE(SUM(amount_kes),0) FROM payments p WHERE p.owner_id=o.id) as total_paid,
      (SELECT COUNT(*) FROM feature_requests fr WHERE fr.owner_id=o.id AND fr.status='PENDING') as pending_requests
    FROM owners o ORDER BY o.created_at DESC`);
  ok(res, owners);
});

app.post('/api/master/owners', authMaster, async (req, res) => {
  const { email, password, name, business_name, phone, kra_pin, notes } = req.body;
  if (!email || !password || !name || !business_name) return err(res, 'email, password, name, business_name required');
  try {
    const r = await q1(
      'INSERT INTO owners(email,password,name,business_name,phone,kra_pin,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [email, bcrypt.hashSync(password, 10), name, business_name, phone || null, kra_pin || null, notes || null, req.master.id]
    );
    audit(req.master.email, 'OWNER_CREATE', email, business_name, req.ip);
    ok(res, { id: r.id }, 'Owner account created');
  } catch (e) { err(res, 'Email already exists'); }
});

app.put('/api/master/owners/:id', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const o  = await q1('SELECT * FROM owners WHERE id=$1', [id]);
  if (!o) return err(res, 'Not found', 404);
  const { name, business_name, phone, kra_pin, status, notes } = req.body;
  await pool.query(
    'UPDATE owners SET name=COALESCE($1,name),business_name=COALESCE($2,business_name),phone=$3,kra_pin=$4,status=COALESCE($5,status),notes=$6 WHERE id=$7',
    [name, business_name, phone, kra_pin, status, notes, id]
  );
  if (status === 'SUSPENDED' && o.status !== 'SUSPENDED') {
    await pool.query("UPDATE shops SET status='SUSPENDED' WHERE owner_id=$1", [id]);
    const shops = await q('SELECT id FROM shops WHERE owner_id=$1', [id]);
    shops.forEach(s => broadcastToShop(s.id, 'remote_command', { command: 'SHOP_SUSPENDED', payload: { message: 'Account suspended. Contact support.' } }));
  }
  audit(req.master.email, 'OWNER_UPDATE', o.email, `status:${status}`, req.ip);
  ok(res, null, 'Updated');
});

app.delete('/api/master/owners/:id', authSuper, async (req, res) => {
  const o = await q1('SELECT * FROM owners WHERE id=$1', [parseInt(req.params.id)]);
  if (!o) return err(res, 'Not found', 404);
  await pool.query('DELETE FROM owners WHERE id=$1', [o.id]);
  audit(req.master.email, 'OWNER_DELETE', o.email, null, req.ip);
  ok(res, null, 'Deleted');
});

app.post('/api/master/owners/:id/reset-password', authMaster, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) return err(res, 'Min 8 characters');
  await pool.query('UPDATE owners SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), parseInt(req.params.id)]);
  audit(req.master.email, 'OWNER_PASS_RESET', req.params.id, null, req.ip);
  ok(res, null, 'Password reset');
});

// Master Users
app.get('/api/master/users', authSuper, async (req, res) => {
  ok(res, await q('SELECT id,email,name,role,active,created_at,last_login FROM master_users ORDER BY created_at DESC'));
});
app.post('/api/master/users', authSuper, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return err(res, 'email, password, name required');
  try {
    const r = await q1(
      'INSERT INTO master_users(email,password,name,role) VALUES($1,$2,$3,$4) RETURNING id',
      [email, bcrypt.hashSync(password, 10), name, role || 'ADMIN']
    );
    audit(req.master.email, 'MASTER_USER_CREATE', email, null, req.ip);
    ok(res, { id: r.id }, 'Admin user created');
  } catch (e) { err(res, 'Email already exists'); }
});

// Feature catalog
app.get('/api/master/features/catalog', authMaster, async (req, res) => {
  ok(res, await q('SELECT * FROM feature_catalog ORDER BY sort_order ASC'));
});
app.post('/api/master/features/catalog', authMaster, async (req, res) => {
  const { key, name, description, price_kes, category, sort_order } = req.body;
  if (!key || !name) return err(res, 'key and name required');
  try {
    const r = await q1(
      'INSERT INTO feature_catalog(key,name,description,price_kes,category,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [key, name, description || null, price_kes || 0, category || 'general', sort_order || 99]
    );
    audit(req.master.email, 'FEATURE_CREATE', key, `price:${price_kes}`, req.ip);
    ok(res, { id: r.id }, 'Feature created');
  } catch (e) { err(res, 'Feature key already exists'); }
});
app.put('/api/master/features/catalog/:key', authMaster, async (req, res) => {
  const { name, description, price_kes, category, active, sort_order } = req.body;
  await pool.query(
    'UPDATE feature_catalog SET name=COALESCE($1,name),description=$2,price_kes=COALESCE($3,price_kes),category=COALESCE($4,category),active=COALESCE($5,active),sort_order=COALESCE($6,sort_order) WHERE key=$7',
    [name, description, price_kes, category, active, sort_order, req.params.key]
  );
  audit(req.master.email, 'FEATURE_UPDATE', req.params.key, `price:${price_kes}`, req.ip);
  ok(res, null, 'Updated');
});

// Feature requests inbox
app.get('/api/master/features/requests', authMaster, async (req, res) => {
  const status = req.query.status || null;
  const sql = `SELECT fr.*,o.business_name,o.email as owner_email,s.name as shop_name
               FROM feature_requests fr JOIN owners o ON fr.owner_id=o.id
               LEFT JOIN shops s ON fr.shop_id=s.id
               ${status ? 'WHERE fr.status=$1' : ''}
               ORDER BY fr.created_at DESC`;
  ok(res, status ? await q(sql, [status]) : await q(sql));
});

app.post('/api/master/features/requests/:id/approve', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const { price_kes, expires_days } = req.body;
  const fr = await q1('SELECT * FROM feature_requests WHERE id=$1', [id]);
  if (!fr) return err(res, 'Request not found', 404);
  if (fr.status !== 'PENDING') return err(res, 'Request already processed');

  const expiresAt = expires_days
    ? new Date(Date.now() + parseInt(expires_days) * 86400000).toISOString()
    : null;

  await pool.query(
    `INSERT INTO subscriptions(owner_id,shop_id,feature_key,status,price_kes,expires_at)
     VALUES($1,$2,$3,'ACTIVE',$4,$5)
     ON CONFLICT(owner_id,shop_id,feature_key) DO UPDATE
     SET status='ACTIVE',price_kes=EXCLUDED.price_kes,expires_at=EXCLUDED.expires_at,renewed_at=NOW()`,
    [fr.owner_id, fr.shop_id || null, fr.feature_key, price_kes || fr.price_kes || 0, expiresAt]
  );

  await pool.query(
    "UPDATE feature_requests SET status='APPROVED',price_kes=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3",
    [price_kes || 0, req.master.id, id]
  );

  if (fr.shop_id) {
    const shop = await q1('SELECT * FROM shops WHERE id=$1', [fr.shop_id]);
    if (shop) {
      let feats; try { feats = JSON.parse(shop.features); } catch (e) { feats = {}; }
      feats[fr.feature_key] = true;
      await pool.query('UPDATE shops SET features=$1 WHERE id=$2', [JSON.stringify(feats), fr.shop_id]);
      broadcastToShop(fr.shop_id, 'features_updated', { features: feats });
    }
  }

  notifyOwner(fr.owner_id, 'feature_approved', {
    feature_key: fr.feature_key, feature_name: fr.feature_name,
    price_kes: price_kes || 0, expires_at: expiresAt,
  });
  audit(req.master.email, 'REQUEST_APPROVE', fr.feature_name, `owner:${fr.owner_id} price:${price_kes}`, req.ip);
  ok(res, null, 'Request approved and feature activated');
});

app.post('/api/master/features/requests/:id/reject', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const { reason } = req.body;
  const fr = await q1('SELECT * FROM feature_requests WHERE id=$1', [id]);
  if (!fr) return err(res, 'Request not found', 404);
  await pool.query(
    "UPDATE feature_requests SET status='REJECTED',reject_reason=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3",
    [reason || null, req.master.id, id]
  );
  notifyOwner(fr.owner_id, 'feature_rejected', { feature_key: fr.feature_key, feature_name: fr.feature_name, reason });
  audit(req.master.email, 'REQUEST_REJECT', fr.feature_name, `reason:${reason}`, req.ip);
  ok(res, null, 'Request rejected');
});

// Subscriptions
app.get('/api/master/subscriptions', authMaster, async (req, res) => {
  ok(res, await q(`
    SELECT sub.*, o.business_name, o.email as owner_email, s.name as shop_name,
      fc.name as feature_name, fc.category
    FROM subscriptions sub
    JOIN owners o ON sub.owner_id=o.id
    LEFT JOIN shops s ON sub.shop_id=s.id
    JOIN feature_catalog fc ON sub.feature_key=fc.key
    ORDER BY sub.started_at DESC`));
});

// Payments
app.get('/api/master/payments', authMaster, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  ok(res, await q(`
    SELECT p.*, o.business_name, o.email as owner_email, s.name as shop_name
    FROM payments p JOIN owners o ON p.owner_id=o.id
    LEFT JOIN shops s ON p.shop_id=s.id
    ORDER BY p.created_at DESC LIMIT $1`, [limit]));
});

app.post('/api/master/payments', authMaster, async (req, res) => {
  const { owner_id, shop_id, feature_key, amount_kes, method, reference, description } = req.body;
  if (!owner_id || !amount_kes) return err(res, 'owner_id and amount_kes required');
  const r = await q1(
    'INSERT INTO payments(owner_id,shop_id,feature_key,amount_kes,method,reference,description,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [owner_id, shop_id || null, feature_key || null, amount_kes, method || 'MANUAL', reference || null, description || null, req.master.id]
  );
  audit(req.master.email, 'PAYMENT_RECORD', `owner:${owner_id}`, `KES ${amount_kes}`, req.ip);
  ok(res, { id: r.id }, 'Payment recorded');
});

// Shops (master)
app.get('/api/master/shops', authMaster, async (req, res) => {
  const shops = await q(`
    SELECT s.*,
      o.business_name as owner_name, o.email as owner_email,
      (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='APPROVED') AS device_count,
      (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='PENDING')  AS pending_devices,
      (SELECT MAX(d.last_seen)  FROM devices d     WHERE d.shop_id=s.id) AS last_activity,
      (SELECT MAX(b.synced_at)  FROM cloud_backups b WHERE b.shop_id=s.id) AS last_sync
    FROM shops s LEFT JOIN owners o ON s.owner_id=o.id
    ORDER BY s.created_at DESC`);
  shops.forEach(s => { try { s.features = JSON.parse(s.features); } catch (e) { s.features = {}; } });
  ok(res, shops);
});

app.get('/api/master/shops/:id', authMaster, async (req, res) => {
  const s = await q1(
    'SELECT s.*,o.business_name as owner_name,o.email as owner_email FROM shops s LEFT JOIN owners o ON s.owner_id=o.id WHERE s.id=$1',
    [parseInt(req.params.id)]
  );
  if (!s) return err(res, 'Not found', 404);
  try { s.features = JSON.parse(s.features); } catch (e) { s.features = {}; }
  ok(res, s);
});

app.post('/api/master/shops', authMaster, async (req, res) => {
  const { name, location, phone, email, kra_pin, plan, expires_at, monthly_fee, owner_id } = req.body;
  if (!name) return err(res, 'Shop name required');
  const lk = genLicense();
  const feats = {
    mpesa: plan === 'PRO' || plan === 'ENTERPRISE', etims: plan === 'ENTERPRISE',
    multi_cashier: true, reports: plan !== 'BASIC', payroll: plan === 'ENTERPRISE',
    credit: plan !== 'BASIC', repair: plan === 'ENTERPRISE', stocktake: true, analytics: plan !== 'BASIC',
  };
  const r = await q1(
    `INSERT INTO shops(name,location,phone,email,kra_pin,license_key,plan,features,expires_at,monthly_fee,owner_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name, location || null, phone || null, email || null, kra_pin || null, lk, plan || 'BASIC', JSON.stringify(feats), expires_at || null, monthly_fee || 0, owner_id || null]
  );
  audit(req.master.email, 'SHOP_CREATE', name, `plan:${plan} owner:${owner_id}`, req.ip);
  try { r.features = JSON.parse(r.features); } catch (e) {}
  ok(res, r, 'Shop created');
});

app.put('/api/master/shops/:id', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const s  = await q1('SELECT * FROM shops WHERE id=$1', [id]);
  if (!s) return err(res, 'Not found', 404);
  const { name, location, phone, email, kra_pin, plan, status, features, expires_at, monthly_fee, owner_id } = req.body;
  await pool.query(
    'UPDATE shops SET name=$1,location=$2,phone=$3,email=$4,kra_pin=$5,plan=$6,status=$7,features=$8,expires_at=$9,monthly_fee=$10,owner_id=$11 WHERE id=$12',
    [name || s.name, location, phone, email, kra_pin, plan || s.plan, status || s.status,
      features ? JSON.stringify(features) : s.features, expires_at, monthly_fee ?? s.monthly_fee, owner_id ?? s.owner_id, id]
  );
  if (status === 'SUSPENDED' && s.status !== 'SUSPENDED') {
    await pool.query("INSERT INTO remote_commands(shop_id,command,payload) VALUES($1,'SHOP_SUSPENDED',$2)", [id, JSON.stringify({ message: 'Account suspended.' })]);
    broadcastToShop(id, 'remote_command', { command: 'SHOP_SUSPENDED', payload: { message: 'Account suspended' } });
  }
  audit(req.master.email, 'SHOP_UPDATE', s.name, `status:${status}`, req.ip);
  ok(res, null, 'Updated');
});

app.delete('/api/master/shops/:id', authSuper, async (req, res) => {
  const s = await q1('SELECT * FROM shops WHERE id=$1', [parseInt(req.params.id)]);
  if (!s) return err(res, 'Not found', 404);
  await pool.query('DELETE FROM shops WHERE id=$1', [s.id]);
  audit(req.master.email, 'SHOP_DELETE', s.name, null, req.ip);
  ok(res, null, 'Deleted');
});

app.post('/api/master/shops/:id/features', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const s  = await q1('SELECT * FROM shops WHERE id=$1', [id]);
  if (!s) return err(res, 'Not found', 404);
  let feats; try { feats = JSON.parse(s.features); } catch (e) { feats = {}; }
  Object.assign(feats, req.body);
  await pool.query('UPDATE shops SET features=$1 WHERE id=$2', [JSON.stringify(feats), id]);
  broadcastToShop(id, 'features_updated', { features: feats });
  audit(req.master.email, 'FEATURES_UPDATE', s.name, JSON.stringify(req.body), req.ip);
  ok(res, feats, 'Features updated and pushed');
});

app.get('/api/master/shops/:id/stats', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const today = new Date().toISOString().split('T')[0];
  const thisMonth = new Date().toISOString().slice(0, 7);
  let stats = { total_sales: 0, total_revenue: 0, today_sales: 0, today_revenue: 0, month_sales: 0, month_revenue: 0, daily_revenue: {} };
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); stats.daily_revenue[d.toISOString().split('T')[0]] = 0; }
  const backup = await q1("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [id]);
  if (backup) { try {
    const inv = JSON.parse(backup.data);
    stats.total_sales = inv.length;
    stats.total_revenue = inv.reduce((s, i) => s + (i.total || i.grand_total || 0), 0);
    inv.filter(i => (i.created_at || i.date || '').startsWith(today)).forEach(i => { stats.today_sales++; stats.today_revenue += (i.total || i.grand_total || 0); });
    inv.filter(i => (i.created_at || i.date || '').startsWith(thisMonth)).forEach(i => { stats.month_sales++; stats.month_revenue += (i.total || i.grand_total || 0); });
    for (const i of inv) { const d = (i.created_at || i.date || '').split('T')[0]; if (stats.daily_revenue[d] !== undefined) stats.daily_revenue[d] += (i.total || i.grand_total || 0); }
  } catch (e) {} }
  const dc = await q1("SELECT COUNT(*) as c FROM devices WHERE shop_id=$1 AND status='APPROVED'", [id]);
  const ls = await q1('SELECT MAX(synced_at) as ts FROM cloud_backups WHERE shop_id=$1', [id]);
  stats.device_count = +dc.c;
  stats.last_sync = ls?.ts;
  ok(res, stats);
});

// Devices (master)
app.get('/api/master/devices', authMaster, async (req, res) => {
  ok(res, await q('SELECT d.*,s.name AS shop_name,o.business_name as owner_name FROM devices d JOIN shops s ON d.shop_id=s.id LEFT JOIN owners o ON s.owner_id=o.id ORDER BY d.registered_at DESC'));
});
app.get('/api/master/devices/pending', authMaster, async (req, res) => {
  ok(res, await q("SELECT d.*,s.name AS shop_name,s.license_key,o.business_name as owner_name FROM devices d JOIN shops s ON d.shop_id=s.id LEFT JOIN owners o ON s.owner_id=o.id WHERE d.status='PENDING' ORDER BY d.registered_at DESC"));
});
app.get('/api/master/shops/:id/devices', authMaster, async (req, res) => {
  ok(res, await q('SELECT * FROM devices WHERE shop_id=$1 ORDER BY registered_at DESC', [parseInt(req.params.id)]));
});
app.post('/api/master/devices/:deviceId/approve', authMaster, async (req, res) => {
  const { deviceId } = req.params;
  const d = await q1('SELECT * FROM devices WHERE device_id=$1', [deviceId]);
  if (!d) return err(res, 'Not found', 404);
  await pool.query("UPDATE devices SET status='APPROVED',approved_at=NOW(),approved_by=$1 WHERE device_id=$2", [req.master.id, deviceId]);
  broadcastToDevice(deviceId, 'device_approved', { device_id: deviceId });
  io.to('admin_room').emit('device_status_changed', { device_id: deviceId, status: 'APPROVED' });
  audit(req.master.email, 'DEVICE_APPROVE', deviceId, d.name, req.ip);
  ok(res, null, 'Device approved');
});
app.post('/api/master/devices/:deviceId/block', authMaster, async (req, res) => {
  const { deviceId } = req.params;
  await pool.query("UPDATE devices SET status='BLOCKED' WHERE device_id=$1", [deviceId]);
  broadcastToDevice(deviceId, 'device_blocked', { message: 'Blocked by admin' });
  audit(req.master.email, 'DEVICE_BLOCK', deviceId, null, req.ip);
  ok(res, null, 'Blocked');
});
app.delete('/api/master/devices/:deviceId', authMaster, async (req, res) => {
  await pool.query('DELETE FROM devices WHERE device_id=$1', [req.params.deviceId]);
  audit(req.master.email, 'DEVICE_DELETE', req.params.deviceId, null, req.ip);
  ok(res, null, 'Removed');
});

// Remote Commands
app.post('/api/master/shops/:id/command', authMaster, async (req, res) => {
  const id = parseInt(req.params.id);
  const { command, device_id, payload } = req.body;
  const valid = ['LOCK_POS', 'UNLOCK_POS', 'FORCE_LOGOUT', 'RELOAD_APP', 'MESSAGE', 'SHOP_SUSPENDED'];
  if (!valid.includes(command)) return err(res, 'Invalid command');
  await pool.query('INSERT INTO remote_commands(shop_id,device_id,command,payload,issued_by) VALUES($1,$2,$3,$4,$5)',
    [id, device_id || null, command, JSON.stringify(payload || {}), req.master.id]);
  if (device_id) broadcastToDevice(device_id, 'remote_command', { command, payload: payload || {} });
  else broadcastToShop(id, 'remote_command', { command, payload: payload || {} });
  audit(req.master.email, 'REMOTE_CMD', command, `shop:${id} dev:${device_id || 'all'}`, req.ip);
  ok(res, null, `Command ${command} sent`);
});

// Audit
app.get('/api/master/audit', authMaster, async (req, res) => {
  ok(res, await q('SELECT * FROM server_audit ORDER BY ts DESC LIMIT $1', [Math.min(parseInt(req.query.limit) || 100, 500)]));
});

// ═══════════════════════════════════════════════════════════════
//  OWNER API  (/api/owner/*)
// ═══════════════════════════════════════════════════════════════

app.post('/api/owner/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'Email and password required');
  const o = await q1("SELECT * FROM owners WHERE email=$1 AND status!='DELETED'", [email]);
  if (!o || !bcrypt.compareSync(password, o.password)) {
    audit(email, 'OWNER_LOGIN_FAIL', null, null, req.ip);
    return err(res, 'Invalid credentials', 401);
  }
  if (o.status === 'SUSPENDED') return err(res, 'Account suspended. Contact support.', 403);
  await pool.query('UPDATE owners SET last_login=NOW() WHERE id=$1', [o.id]);
  audit(o.email, 'OWNER_LOGIN', null, null, req.ip);
  const token = jwt.sign({ id: o.id, email: o.email, type: 'owner', name: o.name, business: o.business_name }, JWT_SECRET, { expiresIn: JWT_EXP });
  ok(res, { token, owner: { id: o.id, email: o.email, name: o.name, business_name: o.business_name } });
});

app.get('/api/owner/me', authOwner, (req, res) => {
  const o = req.owner;
  ok(res, { id: o.id, email: o.email, name: o.name, business_name: o.business_name, phone: o.phone, kra_pin: o.kra_pin, created_at: o.created_at, last_login: o.last_login });
});

app.post('/api/owner/change-password', authOwner, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return err(res, 'Both passwords required');
  if (new_password.length < 8) return err(res, 'Min 8 characters');
  if (!bcrypt.compareSync(current_password, req.owner.password)) return err(res, 'Wrong current password');
  await pool.query('UPDATE owners SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.owner.id]);
  ok(res, null, 'Password changed');
});

app.get('/api/owner/dashboard', authOwner, async (req, res) => {
  const ownerId = req.owner.id;
  const shops = await q('SELECT id FROM shops WHERE owner_id=$1', [ownerId]);
  const shopIds = shops.map(s => s.id);
  const today = new Date().toISOString().split('T')[0];
  let todaySales = 0, todayRevenue = 0, totalSales = 0;
  for (const shopId of shopIds) {
    const backup = await q1("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [shopId]);
    if (backup) { try {
      const inv = JSON.parse(backup.data);
      totalSales += inv.length;
      inv.filter(i => (i.created_at || i.date || '').startsWith(today)).forEach(i => { todaySales++; todayRevenue += (i.total || i.grand_total || 0); });
    } catch (e) {} }
  }
  const [activeSubs, pendingReqs, totalDevices] = await Promise.all([
    q1("SELECT COUNT(*) as c FROM subscriptions WHERE owner_id=$1 AND status='ACTIVE'", [ownerId]),
    q1("SELECT COUNT(*) as c FROM feature_requests WHERE owner_id=$1 AND status='PENDING'", [ownerId]),
    shopIds.length
      ? q1(`SELECT COUNT(*) as c FROM devices WHERE shop_id=ANY($1) AND status='APPROVED'`, [shopIds])
      : Promise.resolve({ c: 0 }),
  ]);
  ok(res, { todaySales, todayRevenue, totalSales, activeSubs: +activeSubs.c, pendingReqs: +pendingReqs.c, totalDevices: +totalDevices.c, shopCount: shops.length });
});

app.get('/api/owner/shops', authOwner, async (req, res) => {
  const shops = await q(`
    SELECT s.*,
      (SELECT COUNT(*) FROM devices d WHERE d.shop_id=s.id AND d.status='APPROVED') AS device_count,
      (SELECT MAX(d.last_seen) FROM devices d WHERE d.shop_id=s.id) AS last_activity,
      (SELECT MAX(b.synced_at) FROM cloud_backups b WHERE b.shop_id=s.id) AS last_sync
    FROM shops s WHERE s.owner_id=$1 ORDER BY s.created_at DESC`, [req.owner.id]);
  shops.forEach(s => { try { s.features = JSON.parse(s.features); } catch (e) { s.features = {}; } });
  ok(res, shops);
});

app.get('/api/owner/shops/:id/stats', authOwner, async (req, res) => {
  const id = parseInt(req.params.id);
  const shop = await q1('SELECT * FROM shops WHERE id=$1 AND owner_id=$2', [id, req.owner.id]);
  if (!shop) return err(res, 'Not found or not yours', 404);
  const today = new Date().toISOString().split('T')[0];
  const thisMonth = new Date().toISOString().slice(0, 7);
  let stats = { total_sales: 0, total_revenue: 0, today_sales: 0, today_revenue: 0, month_sales: 0, month_revenue: 0, daily_revenue: {} };
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); stats.daily_revenue[d.toISOString().split('T')[0]] = 0; }
  const backup = await q1("SELECT data FROM cloud_backups WHERE shop_id=$1 AND store_name='invoices' ORDER BY synced_at DESC LIMIT 1", [id]);
  if (backup) { try {
    const inv = JSON.parse(backup.data);
    stats.total_sales = inv.length; stats.total_revenue = inv.reduce((s, i) => s + (i.total || i.grand_total || 0), 0);
    inv.filter(i => (i.created_at || i.date || '').startsWith(today)).forEach(i => { stats.today_sales++; stats.today_revenue += (i.total || i.grand_total || 0); });
    inv.filter(i => (i.created_at || i.date || '').startsWith(thisMonth)).forEach(i => { stats.month_sales++; stats.month_revenue += (i.total || i.grand_total || 0); });
    for (const i of inv) { const d = (i.created_at || i.date || '').split('T')[0]; if (stats.daily_revenue[d] !== undefined) stats.daily_revenue[d] += (i.total || i.grand_total || 0); }
  } catch (e) {} }
  ok(res, stats);
});

app.get('/api/owner/marketplace', authOwner, async (req, res) => {
  const [catalog, activeSubs, pendingReqs] = await Promise.all([
    q('SELECT * FROM feature_catalog WHERE active=1 ORDER BY sort_order ASC'),
    q("SELECT feature_key,shop_id,status,expires_at FROM subscriptions WHERE owner_id=$1 AND status='ACTIVE'", [req.owner.id]),
    q("SELECT feature_key,shop_id,status FROM feature_requests WHERE owner_id=$1 AND status='PENDING'", [req.owner.id]),
  ]);
  const subMap = {}; activeSubs.forEach(s => { subMap[s.feature_key + (s.shop_id || '')] = { status: s.status, expires_at: s.expires_at }; });
  const reqMap = {}; pendingReqs.forEach(r => { reqMap[r.feature_key + (r.shop_id || '')] = 'PENDING'; });
  ok(res, catalog.map(f => ({
    ...f,
    subscription: subMap[f.key + ''] || subMap[f.key + 'null'] || null,
    request_status: reqMap[f.key + ''] || reqMap[f.key + 'null'] || null,
  })));
});

app.post('/api/owner/request-feature', authOwner, async (req, res) => {
  const { feature_key, shop_id, message } = req.body;
  if (!feature_key) return err(res, 'feature_key required');
  const feat = await q1('SELECT * FROM feature_catalog WHERE key=$1 AND active=1', [feature_key]);
  if (!feat) return err(res, 'Feature not found');
  if (shop_id) {
    const shop = await q1('SELECT * FROM shops WHERE id=$1 AND owner_id=$2', [shop_id, req.owner.id]);
    if (!shop) return err(res, 'Shop not yours', 403);
  }
  const existing = await q1(
    "SELECT * FROM feature_requests WHERE owner_id=$1 AND feature_key=$2 AND shop_id IS NOT DISTINCT FROM $3 AND status='PENDING'",
    [req.owner.id, feature_key, shop_id || null]
  );
  if (existing) return err(res, 'You already have a pending request for this feature');
  const r = await q1(
    'INSERT INTO feature_requests(owner_id,shop_id,feature_key,feature_name,message,price_kes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [req.owner.id, shop_id || null, feature_key, feat.name, message || null, feat.price_kes]
  );
  io.to('admin_room').emit('new_feature_request', { id: r.id, feature_name: feat.name, business_name: req.owner.business_name, owner_id: req.owner.id });
  audit(req.owner.email, 'FEATURE_REQUEST', feature_key, `shop:${shop_id}`, req.ip);
  ok(res, { id: r.id }, 'Feature request submitted. We will review it shortly.');
});

app.get('/api/owner/subscriptions', authOwner, async (req, res) => {
  ok(res, await q(`
    SELECT sub.*,fc.name as feature_name,fc.description,fc.category,s.name as shop_name
    FROM subscriptions sub
    JOIN feature_catalog fc ON sub.feature_key=fc.key
    LEFT JOIN shops s ON sub.shop_id=s.id
    WHERE sub.owner_id=$1 ORDER BY sub.started_at DESC`, [req.owner.id]));
});

app.get('/api/owner/requests', authOwner, async (req, res) => {
  ok(res, await q(`
    SELECT fr.*,s.name as shop_name FROM feature_requests fr
    LEFT JOIN shops s ON fr.shop_id=s.id
    WHERE fr.owner_id=$1 ORDER BY fr.created_at DESC`, [req.owner.id]));
});

app.get('/api/owner/payments', authOwner, async (req, res) => {
  ok(res, await q('SELECT p.*,s.name as shop_name FROM payments p LEFT JOIN shops s ON p.shop_id=s.id WHERE p.owner_id=$1 ORDER BY p.created_at DESC', [req.owner.id]));
});

// ═══════════════════════════════════════════════════════════════
//  POS DEVICE API  (/api/pos/*)
// ═══════════════════════════════════════════════════════════════

app.post('/api/pos/register', async (req, res) => {
  const { license_key, device_id, device_name, device_type, os, browser } = req.body;
  if (!license_key || !device_id) return err(res, 'license_key and device_id required');
  const shop = await q1("SELECT * FROM shops WHERE license_key=$1 AND status!='SUSPENDED'", [license_key]);
  if (!shop) return err(res, 'Invalid or suspended license key', 403);
  const existing = await q1('SELECT * FROM devices WHERE device_id=$1', [device_id]);
  if (existing) {
    if (existing.status === 'BLOCKED') return err(res, 'DEVICE_BLOCKED', 403);
    await pool.query('UPDATE devices SET name=$1,type=$2,os=$3,browser=$4,ip_address=$5,last_seen=NOW() WHERE device_id=$6',
      [device_name || existing.name, device_type || existing.type, os, browser, req.ip, device_id]);
    const token = jwt.sign({ type: 'device', device_id, shop_id: shop.id }, JWT_SECRET, { expiresIn: JWT_EXP });
    return ok(res, { device_token: token, device_status: existing.status, shop: { id: shop.id, name: shop.name, plan: shop.plan }, features: JSON.parse(shop.features || '{}') });
  }
  const count = await q1("SELECT COUNT(*) as c FROM devices WHERE shop_id=$1 AND status='APPROVED'", [shop.id]);
  const status = +count.c === 0 ? 'APPROVED' : 'PENDING';
  await pool.query('INSERT INTO devices(device_id,shop_id,name,type,os,browser,ip_address,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [device_id, shop.id, device_name || 'New Device', device_type || 'phone', os, browser, req.ip, status]);
  if (status === 'APPROVED') await pool.query('UPDATE devices SET approved_at=NOW() WHERE device_id=$1', [device_id]);
  audit('device', 'DEVICE_REGISTER', device_id, `shop:${shop.name} status:${status}`, req.ip);
  if (status === 'PENDING') io.to('admin_room').emit('new_pending_device', { device_id, device_name, shop_name: shop.name });
  const token = jwt.sign({ type: 'device', device_id, shop_id: shop.id }, JWT_SECRET, { expiresIn: JWT_EXP });
  ok(res, { device_token: token, device_status: status, shop: { id: shop.id, name: shop.name, plan: shop.plan }, features: JSON.parse(shop.features || '{}'), message: status === 'PENDING' ? 'Waiting for admin approval' : 'Device approved' });
});

app.post('/api/pos/auth', authDevice, async (req, res) => {
  const { username, role } = req.body;
  await pool.query('UPDATE devices SET pos_user=$1 WHERE device_id=$2', [username, req.device.device_id]);
  audit('device:' + req.device.device_id, 'POS_LOGIN', username, `role:${role}`, req.ip);
  ok(res, { features: JSON.parse(req.device.features || '{}'), shop: { id: req.device.shop_id } });
});

app.post('/api/pos/sync/push', authDevice, async (req, res) => {
  const { stores } = req.body;
  if (!stores || typeof stores !== 'object') return err(res, 'stores required');
  let total = 0;
  for (const [name, recs] of Object.entries(stores)) {
    if (!Array.isArray(recs)) continue;
    await pool.query(
      `INSERT INTO cloud_backups(shop_id,device_id,store_name,data,record_count,synced_at)
       VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT(shop_id,device_id,store_name) DO UPDATE
       SET data=EXCLUDED.data,record_count=EXCLUDED.record_count,synced_at=NOW()`,
      [req.shopId, req.device.device_id, name, JSON.stringify(recs), recs.length]
    );
    total += recs.length;
  }
  ok(res, { records_synced: total, synced_at: new Date().toISOString() });
});

app.get('/api/pos/sync/pull', authDevice, async (req, res) => {
  const shopId = req.shopId, deviceId = req.device.device_id;
  const since = req.query.since || '1970-01-01';
  const backups = await q('SELECT store_name,data FROM cloud_backups WHERE shop_id=$1 AND device_id!=$2 AND synced_at>$3 ORDER BY synced_at DESC', [shopId, deviceId, since]);
  const storeMap = {};
  for (const b of backups) {
    if (!storeMap[b.store_name]) storeMap[b.store_name] = [];
    try { storeMap[b.store_name].push(...JSON.parse(b.data)); } catch (e) {}
  }
  const cmds = await q("SELECT * FROM remote_commands WHERE shop_id=$1 AND status='PENDING' AND (device_id IS NULL OR device_id=$2) ORDER BY issued_at ASC", [shopId, deviceId]);
  if (cmds.length) {
    const ids = cmds.map(c => c.id);
    await pool.query(`UPDATE remote_commands SET status='DELIVERED',delivered_at=NOW() WHERE id=ANY($1)`, [ids]);
  }
  ok(res, { stores: storeMap, commands: cmds.map(c => ({ command: c.command, payload: JSON.parse(c.payload || '{}') })), server_time: new Date().toISOString() });
});

app.post('/api/pos/heartbeat', authDevice, async (req, res) => {
  const { pos_user } = req.body;
  await pool.query('UPDATE devices SET last_seen=NOW(),pos_user=$1 WHERE device_id=$2', [pos_user || req.device.pos_user, req.device.device_id]);
  const cmds = await q("SELECT * FROM remote_commands WHERE shop_id=$1 AND status='PENDING' AND (device_id IS NULL OR device_id=$2)", [req.shopId, req.device.device_id]);
  ok(res, { status: 'ok', commands: cmds.map(c => ({ command: c.command, payload: JSON.parse(c.payload || '{}') })) });
});

// Server info
app.get('/api/info', async (req, res) => {
  const [shops, devices] = await Promise.all([
    q1("SELECT COUNT(*) as c FROM shops WHERE status='ACTIVE'"),
    q1("SELECT COUNT(*) as c FROM devices WHERE status='APPROVED'"),
  ]);
  ok(res, { server: 'Distore Master Server', version: '3.0', shops: +shops.c, devices: +devices.c, time: new Date().toISOString() });
});

app.get('/', (req, res) => res.send(`<!DOCTYPE html><html><head><title>Distore Server</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0b0e;color:#e8eaf0;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}.b{border:1px solid #2a2f3a;padding:40px;border-radius:12px;text-align:center;max-width:380px}h1{font-size:30px;color:#00d4aa;font-weight:900;letter-spacing:-1px}p{color:#5a6478;font-size:12px;margin:6px 0}a{color:#00d4aa;text-decoration:none;padding:10px 20px;border:1px solid #00d4aa;border-radius:6px;display:inline-block;margin:6px 4px;font-size:12px}a:hover{background:rgba(0,212,170,.1)}</style></head><body><div class="b"><h1>DISTORE</h1><p>Master Server v3.0 · ✅ Running</p><p style="font-size:10px;color:#2a2f3a;margin-top:4px">by Dilly Solutions</p><div style="margin-top:20px"><a href="/api/info">📊 API</a></div><p style="margin-top:20px;font-size:11px;color:#5a6478">Open <b>distore-admin.html</b> in your browser</p></div></body></html>`));

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════
const deviceSockets = new Map();

function broadcastToShop(shopId, event, data)    { io.to(`shop:${shopId}`).emit(event, data); }
function broadcastToDevice(deviceId, event, data) { deviceSockets.get(deviceId)?.emit(event, data); }
function notifyOwner(ownerId, event, data)         { io.to(`owner:${ownerId}`).emit(event, data); }

io.on('connection', socket => {
  let devId = null, shopId = null;

  socket.on('device_auth', ({ device_token, license_key }) => {
    try {
      const p = jwt.verify(device_token, JWT_SECRET);
      if (p.type !== 'device') { socket.emit('auth_error', { message: 'Invalid token' }); return; }
      q1(`SELECT d.*,s.status AS shop_status,s.features,s.plan,s.name AS shop_name
          FROM devices d JOIN shops s ON d.shop_id=s.id
          WHERE d.device_id=$1 AND s.license_key=$2`, [p.device_id, license_key])
        .then(d => {
          if (!d || d.status !== 'APPROVED') { socket.emit('auth_error', { message: d?.status === 'PENDING' ? 'PENDING_APPROVAL' : 'NOT_AUTHORIZED' }); return; }
          devId = d.device_id; shopId = d.shop_id;
          socket.join(`shop:${shopId}`);
          deviceSockets.set(devId, socket);
          pool.query('UPDATE devices SET last_seen=NOW() WHERE device_id=$1', [devId]);
          socket.emit('auth_ok', { device_id: devId, shop_id: shopId, shop_name: d.shop_name, plan: d.plan, features: JSON.parse(d.features || '{}') });
          io.to('admin_room').emit('device_connected', { device_id: devId, device_name: d.name, shop_id: shopId, shop_name: d.shop_name });
        }).catch(() => socket.emit('auth_error', { message: 'DB error' }));
    } catch (e) { socket.emit('auth_error', { message: 'Token error' }); }
  });

  socket.on('owner_auth', ({ token }) => {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      if (p.type !== 'owner') return;
      socket.join(`owner:${p.id}`);
      socket.emit('owner_auth_ok');
    } catch (e) {}
  });

  ['SYNC_DATA', 'DB_CHANGE', 'FULL_SYNC_REQUEST', 'FULL_SYNC_RESPONSE'].forEach(ev => {
    socket.on(ev, data => { if (shopId) socket.to(`shop:${shopId}`).emit(ev, data); });
  });

  socket.on('admin_auth', ({ token }) => {
    try { jwt.verify(token, JWT_SECRET); socket.join('admin_room'); socket.emit('admin_auth_ok'); }
    catch (e) { socket.emit('admin_auth_error'); }
  });

  socket.on('disconnect', () => {
    if (devId) { deviceSockets.delete(devId); io.to('admin_room').emit('device_disconnected', { device_id: devId }); }
  });
});

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════
async function boot() {
  await handleCLI();   // exits early if --reset-admin / --create-owner
  await initSchema();
  await seedData();

  server.listen(PORT, () => {
    const ips = [];
    Object.values(os.networkInterfaces()).forEach(iface => iface.forEach(a => { if (a.family === 'IPv4' && !a.internal) ips.push(a.address); }));
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║  DISTORE MASTER SERVER v3.0          ║');
    console.log('║  PostgreSQL Edition · Dilly Solutions║');
    console.log('╚══════════════════════════════════════╝\n');
    console.log(`🚀  http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`📡  http://${ip}:${PORT}`));
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎛️   Open distore-admin.html in your browser');
    console.log(`📊   API: http://localhost:${PORT}/api/info`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`❌  Port ${PORT} in use.`);
    else console.error('❌ ', e.message);
    process.exit(1);
  });
}

boot().catch(e => { console.error('❌  Boot failed:', e.message); process.exit(1); });

process.on('SIGINT',  () => { pool.end(); console.log('\n👋  Stopped.'); process.exit(0); });
process.on('SIGTERM', () => { pool.end(); process.exit(0); });
