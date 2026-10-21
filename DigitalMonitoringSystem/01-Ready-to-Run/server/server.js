'use strict';
// A Digital Monitoring System for Computers and Other IT Devices at Mukono District Local Government
// Zero-dependency server: REST API + live events (SSE) + SQLite + static dashboard.
//
// Storage is chosen by environment:
//   DATABASE_URL unset  -> SQLite file next to this package. Nothing to install, fully offline.
//   DATABASE_URL set    -> PostgreSQL, so several servers (the district server and any hosted
//                          copy) can share one database. Requires `npm install pg` first.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.MDM_CONFIG || path.join(ROOT, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- config
const defaults = { port: 5103, adminUsername: 'admin', adminPassword: 'Admin@123', jwtSecret: '', offlineAfterMinutes: 15, metricRetentionDays: 7, advertisedHost: '' };
let config = { ...defaults };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (e) { console.error('config.json is not valid JSON:', e.message); process.exit(1); }
}
if (!config.jwtSecret || config.jwtSecret.length < 32) {
  config.jwtSecret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
if (process.env.JWT_SECRET) config.jwtSecret = process.env.JWT_SECRET;
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.ADMIN_USERNAME) config.adminUsername = process.env.ADMIN_USERNAME;
if (process.env.ADMIN_PASSWORD) config.adminPassword = process.env.ADMIN_PASSWORD;
const DB_FILE = process.env.MDM_DB || path.join(DATA_DIR, 'mdm.db');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// ---------------------------------------------------------------- database
// One query interface, two engines. Everything below talks to `db` and never needs to know
// which engine is behind it. SQLite keeps the ready-to-run package dependency-free; setting
// DATABASE_URL switches to PostgreSQL so the district server and a hosted copy can share data.
//
// All three methods are async because PostgreSQL is, and because that is the only shape both
// engines can honour. Callers must `await` them.

// SQLite marks parameters `?`; PostgreSQL numbers them `$1`, `$2`, ... Skipping anything
// inside single quotes keeps literals such as `COALESCE(NULLIF(?,''),vendor)` correct.
function compilePlaceholders(sql) {
  let i = 0, out = '', quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    if (ch === '?' && !quoted) { i++; out += `$${i}`; } else out += ch;
  }
  return out;
}

// The schema is written once. Only the metrics primary key and the epoch-millisecond column
// differ: SQLite integers are always 64-bit, whereas PostgreSQL needs BIGSERIAL and BIGINT.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, hostname TEXT NOT NULL, ip TEXT NOT NULL, vendor TEXT DEFAULT '', platform TEXT DEFAULT '', location TEXT DEFAULT '', status TEXT NOT NULL, cpu INTEGER DEFAULT 0, memory INTEGER DEFAULT 0, disk INTEGER DEFAULT 0, last_seen TEXT, managed INTEGER DEFAULT 1, token_nonce TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS metrics (id %%PK%% NOT NULL, device_id TEXT NOT NULL, cpu INTEGER, memory INTEGER, disk INTEGER, at_ms %%BIG%% NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_metrics ON metrics(device_id, at_ms);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, title TEXT NOT NULL, severity TEXT NOT NULL, source TEXT NOT NULL, timestamp TEXT NOT NULL, acknowledged INTEGER DEFAULT 0, rule_id TEXT DEFAULT '', device_id TEXT DEFAULT '', resolved INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, scope TEXT, status TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, policy_id TEXT NOT NULL, state TEXT, enforced_by TEXT, enforced_at TEXT, message TEXT, UNIQUE(device_id, policy_id));
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, metric TEXT NOT NULL, threshold INTEGER NOT NULL, duration_minutes INTEGER NOT NULL, severity TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, device_name TEXT, platform TEXT, device_id TEXT DEFAULT '', expires_at TEXT NOT NULL, used INTEGER DEFAULT 0);
`.trim();

function sqliteEngine(file) {
  const raw = new DatabaseSync(file);
  return {
    kind: 'sqlite',
    describe: file,
    // WAL keeps readers from blocking the agent heartbeats writing alongside them.
    async bootstrap() { raw.exec(`PRAGMA journal_mode = WAL;\n${SCHEMA.replace('%%PK%%', 'INTEGER PRIMARY KEY AUTOINCREMENT').replace('%%BIG%%', 'INTEGER')}`); },
    async all(sql, ...params) { return raw.prepare(sql).all(...params); },
    async get(sql, ...params) { return raw.prepare(sql).get(...params); },
    async run(sql, ...params) { return { changes: raw.prepare(sql).run(...params).changes }; },
  };
}

function postgresEngine(url) {
  let pg;
  try { pg = require('pg'); }
  catch {
    throw new Error('DATABASE_URL is set but the "pg" driver is not installed. Run "npm install pg" '
      + 'in this folder, or unset DATABASE_URL to fall back to the built-in SQLite database.');
  }
  // PostgreSQL returns BIGINT (OID 20) as a string to avoid silent precision loss. Every
  // BIGINT here is an epoch-millisecond timestamp or a row count, both far below the
  // safe-integer limit, so real numbers are what the rest of this file expects.
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    // A serverless database scales its compute to zero, so the first connection after an idle
    // period pays a cold start on top of the round trip. Failing that early would make the
    // server look broken whenever it is started after a quiet spell.
    connectionTimeoutMillis: 60000,
    // Neon terminates TLS with a certificate Node does not ship a root for.
    ssl: /sslmode=(require|allow|prefer|verify-ca|verify-full)/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  // A pooled connection that dies while idle makes pg-pool emit "error" on the pool. With no
  // listener for it Node treats that as an unhandled error event and terminates the process,
  // so a hosted server would go down whenever the database recycles an idle connection.
  // Logging and dropping it lets the pool open a fresh one on the next query instead.
  pool.on('error', (e) => console.error('idle database connection dropped:', e.message));
  return {
    kind: 'postgres',
    describe: url.replace(/\/\/[^@]*@/, '//***@'),
    // Sent without parameters, so PostgreSQL runs the whole script in one round trip.
    // Every statement is IF NOT EXISTS, so an existing database is left untouched.
    async bootstrap() { await pool.query(SCHEMA.replace('%%PK%%', 'BIGSERIAL PRIMARY KEY').replace('%%BIG%%', 'BIGINT')); },
    async all(sql, ...params) { const r = await pool.query(compilePlaceholders(sql), params); return r.rows; },
    async get(sql, ...params) { const r = await pool.query(compilePlaceholders(sql), params); return r.rows[0]; },
    async run(sql, ...params) { const r = await pool.query(compilePlaceholders(sql), params); return { changes: r.rowCount }; },
  };
}

const db = DATABASE_URL ? postgresEngine(DATABASE_URL) : sqliteEngine(DB_FILE);
const now = () => new Date().toISOString();
const uid = (p) => `${p}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

async function seedDefaults() {
  if ((await db.get('SELECT COUNT(*) c FROM policies')).c === 0) {
    const ins = 'INSERT INTO policies VALUES (?,?,?,?,?,?)';
    await db.run(ins, 'POL-100', 'Standard Endpoint Baseline', 'Compliance', 'All managed computers', 'Active', now());
    await db.run(ins, 'POL-101', 'Network Access Guardrail', 'Security', 'Perimeter devices', 'Active', now());
    await db.run(ins, 'POL-102', 'Patch Enforcement Window', 'Operations', 'Managed fleet', 'Scheduled', now());
  }
  if ((await db.get('SELECT COUNT(*) c FROM rules')).c === 0) {
    const ins = 'INSERT INTO rules VALUES (?,?,?,?,?,?,?,?)';
    await db.run(ins, 'RULE-CPU', 'High CPU usage', 'cpu', 90, 5, 'High', 1, now());
    await db.run(ins, 'RULE-MEM', 'High memory usage', 'memory', 90, 5, 'Medium', 1, now());
    await db.run(ins, 'RULE-DISK', 'Disk almost full', 'disk', 90, 0, 'Medium', 1, now());
    await db.run(ins, 'RULE-OFFLINE', 'Device stopped reporting', 'offline', config.offlineAfterMinutes, 0, 'High', 1, now());
  }
}

async function seedDistrictDemoFleet() {
  const departments = [
    'Administration', 'Finance', 'Education', 'Health', 'Works', 'Procurement',
    'Planning', 'Works', 'Community', 'Agriculture', 'Human Resource', 'Revenue'
  ];
  const profiles = [
    { prefix: 'WS', vendor: 'Dell', platform: 'Windows 11 Pro' },
    { prefix: 'LT', vendor: 'HP', platform: 'Windows 11 Pro' },
    { prefix: 'SR', vendor: 'Lenovo', platform: 'Windows 10 Pro' },
    { prefix: 'PR', vendor: 'Canon', platform: 'Printer' },
    { prefix: 'AP', vendor: 'Cisco', platform: 'Access Point' },
    { prefix: 'NVR', vendor: 'Hikvision', platform: 'CCTV Recorder' },
    { prefix: 'UPS', vendor: 'APC', platform: 'UPS' }
  ];

  const insert = 'INSERT INTO devices (id, hostname, ip, vendor, platform, location, status, cpu, memory, disk, last_seen, managed, token_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, 0, \'\', ?) ON CONFLICT(id) DO NOTHING';
  const migrateDemo = `
    UPDATE devices
    SET hostname=?, ip=?, vendor=?, platform=?, location=?, status='Demo only',
        cpu=0, memory=0, disk=0, last_seen=NULL, managed=0, token_nonce=''
    WHERE id=? AND (
      hostname LIKE 'MUK-WS-%' OR hostname LIKE 'MUK-LT-%' OR hostname LIKE 'MUK-SR-%'
      OR hostname LIKE 'MUK-PR-%' OR hostname LIKE 'MUK-AP-%' OR hostname LIKE 'MUK-NVR-%'
      OR hostname LIKE 'MUK-UPS-%' OR hostname LIKE 'DEMO-MUK-%'
    )
  `;
  const generatedAt = now();

  for (let i = 1; i <= 200; i++) {
    const profile = profiles[(i - 1) % profiles.length];
    const department = departments[(i - 1) % departments.length];
    const id = `MUK-DEV-${String(i).padStart(3, '0')}`;
    const number = String(i).padStart(3, '0');
    const hostname = `DEMO-MUK-${profile.prefix}-${number}`;
    const ip = i <= 100 ? `192.0.2.${i + 10}` : `198.51.100.${i - 90}`;

    // Convert earlier generated rows to unmistakable demo records; none represent live assets.
    await db.run(migrateDemo, hostname, ip, `DEMO - ${profile.vendor}`, `DEMO - ${profile.platform}`, `DEMO ONLY - ${department} Office`, id);
    await db.run(insert, id, hostname, ip, `DEMO - ${profile.vendor}`, `DEMO - ${profile.platform}`, `DEMO ONLY - ${department} Office`, 'Demo only', generatedAt);
  }

  await db.run("DELETE FROM metrics WHERE device_id LIKE 'MUK-DEV-___'");
  await db.run("DELETE FROM alerts WHERE device_id LIKE 'MUK-DEV-___' OR source LIKE 'MUK-WS-%' OR source LIKE 'MUK-LT-%' OR source LIKE 'MUK-SR-%' OR source LIKE 'MUK-PR-%' OR source LIKE 'MUK-AP-%' OR source LIKE 'MUK-NVR-%' OR source LIKE 'MUK-UPS-%' OR source LIKE 'DEMO-MUK-%'");
}

// Called from startServer(). Seeding the demo fleet is 200 rows written one at a time, which
// against a remote database turns every restart into a long silent pause. So it only runs when
// there is actually something to do: an empty table, or rows still carrying the hostname
// pattern from an earlier version that this pass rewrites.
async function seedAll() {
  await seedDefaults();
  const total = (await db.get('SELECT COUNT(*) c FROM devices')).c;
  const legacy = total === 0 ? 1 : (await db.get(
    "SELECT COUNT(*) c FROM devices WHERE hostname LIKE 'MUK-WS-%' OR hostname LIKE 'MUK-LT-%' OR hostname LIKE 'MUK-SR-%'"
    + " OR hostname LIKE 'MUK-PR-%' OR hostname LIKE 'MUK-AP-%' OR hostname LIKE 'MUK-NVR-%' OR hostname LIKE 'MUK-UPS-%'",
  )).c;
  if (!legacy) return;
  await seedDistrictDemoFleet();
}

// ---------------------------------------------------------------- tokens
const b64 = (b) => Buffer.from(b).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', config.jwtSecret).update(s).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function signJwt(payload, hours) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + hours * 3600 }));
  return `${head}.${body}.${hmac(`${head}.${body}`)}`;
}
function verifyJwt(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || !safeEq(p[2], hmac(`${p[0]}.${p[1]}`))) return null;
  try { const body = JSON.parse(Buffer.from(p[1], 'base64url').toString()); return body.exp > Date.now() / 1000 ? body : null; } catch { return null; }
}
async function issueDeviceToken(deviceId) {
  const nonce = crypto.randomBytes(12).toString('hex');
  await db.run('UPDATE devices SET token_nonce=? WHERE id=?', nonce, deviceId);
  const payload = b64(JSON.stringify({ d: deviceId, n: nonce, exp: Math.floor(Date.now() / 1000) + 90 * 86400 }));
  return `${payload}.${hmac(payload)}`;
}
async function verifyDeviceToken(token) {
  const p = String(token || '').trim().split('.');
  if (p.length !== 2 || !safeEq(p[1], hmac(p[0]))) return null;
  try {
    const body = JSON.parse(Buffer.from(p[0], 'base64url').toString());
    if (body.exp <= Date.now() / 1000) return null;
    const row = await db.get('SELECT token_nonce FROM devices WHERE id=?', body.d);
    return row && row.token_nonce === body.n ? body.d : null; // only the newest token per device works
  } catch { return null; }
}

// ---------------------------------------------------------------- helpers
const lanIp = () => { for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address; return '127.0.0.1'; };
function baseUrl(req) {
  let host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!host || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) host = config.advertisedHost || lanIp();
  return `http://${host}:${config.port}`;
}
const deviceRow = (d) => ({ id: d.id, hostname: d.hostname, ipAddress: d.ip, status: d.status, cpu: d.cpu, memory: d.memory, location: d.location });
const alertRow = (a) => ({ id: a.id, title: a.title, severity: a.severity, source: a.source, timestamp: a.timestamp, acknowledged: !!a.acknowledged, ruleId: a.rule_id });
// `lower()` rather than SQLite's `COLLATE NOCASE`, because it sorts the same way on both
// engines and keeps this query engine-agnostic.
async function buildDashboard() {
  const devices = await db.all('SELECT * FROM devices ORDER BY lower(hostname)');
  const alerts = await db.all('SELECT * FROM alerts WHERE resolved=0 ORDER BY timestamp DESC');
  const policies = await db.all('SELECT p.*, (SELECT COUNT(*) FROM assignments a WHERE a.policy_id=p.id) n FROM policies p ORDER BY p.id');
  const online = devices.filter((d) => d.status === 'Online');
  const avg = (k) => (online.length ? Math.round((online.reduce((s, d) => s + d[k], 0) / online.length) * 10) / 10 : 0);
  return {
    totalDevices: devices.length, onlineDevices: online.length,
    openAlerts: alerts.filter((a) => !a.acknowledged).length, criticalAlerts: alerts.filter((a) => a.severity === 'High').length,
    avgCpu: avg('cpu'), avgMemory: avg('memory'),
    devices: devices.map(deviceRow), alerts: alerts.map(alertRow),
    policies: policies.map((p) => ({ id: p.id, name: p.name, category: p.category, scope: p.scope, status: p.status, assignedDevices: p.n, updatedAt: p.updated_at })),
  };
}

// live updates to open dashboards
const clients = new Set();
// Reads the dashboard and pushes it to every open browser. Never let a slow database or a
// disconnected client take down the caller: failures are logged and swallowed.
async function broadcast() {
  if (!clients.size) return;
  let msg;
  try { msg = `event: dashboard\ndata: ${JSON.stringify(await buildDashboard())}\n\n`; }
  catch (e) { console.error('broadcast skipped:', e.message); return; }
  for (const res of clients) res.write(msg);
}

// ---------------------------------------------------------------- alert engine
// The engine used to ask the database once per device per rule. That is free against a local
// SQLite file and unusable across a wide-area link, where one round trip can cost hundreds of
// milliseconds: 30 managed devices and 4 rules meant roughly 200 round trips on every
// heartbeat, measured at over a minute per heartbeat against a hosted PostgreSQL. So the
// inputs are now read in a fixed number of queries, evaluated in memory, and the results
// written back one statement each. Work no longer grows with the size of the fleet.

// Alerts whose device was removed, or whose rule is gone or disabled, can never resolve on
// their own and have to be closed here.
async function resolveOrphanAlerts() {
  const r = await db.run("UPDATE alerts SET resolved=1 WHERE device_id<>'' AND resolved=0 AND (device_id NOT IN (SELECT id FROM devices) OR rule_id NOT IN (SELECT id FROM rules WHERE enabled=1))");
  return r.changes;
}

async function evaluateRules() {
  const t = Date.now();
  const rules = await db.all('SELECT * FROM rules WHERE enabled=1');
  const devices = await db.all('SELECT * FROM devices WHERE managed=1');
  if (!rules.length || !devices.length) return resolveOrphanAlerts();

  // One window covers every rule, so the widest one wins when reading metrics. An instant
  // rule has no window of its own, but its "latest sample only" reading still falls inside
  // this range: a breach additionally requires a heartbeat in the last two minutes.
  const widestMs = Math.max(...rules.map((r) => (r.duration_minutes > 0 ? r.duration_minutes * 60000 : 120000)));
  const [metricRows, openAlerts] = await Promise.all([
    db.all('SELECT device_id, cpu, memory, disk, at_ms FROM metrics WHERE at_ms>=?', t - widestMs),
    db.all('SELECT id, rule_id, device_id FROM alerts WHERE resolved=0'),
  ]);

  const metricsByDevice = new Map();
  for (const row of metricRows) {
    let list = metricsByDevice.get(row.device_id);
    if (!list) metricsByDevice.set(row.device_id, list = []);
    list.push(row);
  }
  for (const list of metricsByDevice.values()) list.sort((a, b) => a.at_ms - b.at_ms);

  const openIndex = new Map();
  for (const a of openAlerts) openIndex.set(`${a.rule_id} ${a.device_id}`, a.id);

  const newAlerts = [], resolveIds = [];
  for (const rule of rules) {
    const windowMs = rule.duration_minutes > 0 ? rule.duration_minutes * 60000 : 120000;
    const instant = rule.duration_minutes === 0;
    for (const d of devices) {
      let breached = false, detail = '';
      const last = d.last_seen ? Date.parse(d.last_seen) : 0;
      if (rule.metric === 'offline') {
        breached = !last || t - last > rule.threshold * 60000;
        detail = `no heartbeat for over ${rule.threshold} minutes`;
      } else if (['cpu', 'memory', 'disk'].includes(rule.metric)) {
        const all = metricsByDevice.get(d.id) || [];
        const rows = instant ? all.slice(-1) : all.filter((r) => r.at_ms >= t - windowMs);
        // a sustained breach needs every sample in the window above the threshold and enough history to span it
        const spans = instant || (rows.length > 1 && rows[rows.length - 1].at_ms - rows[0].at_ms >= windowMs * 0.8);
        breached = d.status === 'Online' && last > t - 120000 && rows.length > 0 && spans && rows.every((r) => r[rule.metric] > rule.threshold);
        detail = `${rule.metric.toUpperCase()} above ${rule.threshold}%${rule.duration_minutes ? ` for ${rule.duration_minutes} min` : ''}`;
      } else continue;
      const openId = openIndex.get(`${rule.id} ${d.id}`);
      if (breached && !openId) newAlerts.push([uid('ALT'), `${rule.name}: ${detail}`, rule.severity, d.hostname, now(), rule.id, d.id]);
      else if (!breached && openId) resolveIds.push(openId);
    }
  }

  let changed = 0;
  const CHUNK = 100; // keeps a single statement's parameter list a sensible size
  for (let i = 0; i < newAlerts.length; i += CHUNK) {
    const chunk = newAlerts.slice(i, i + CHUNK);
    await db.run(
      `INSERT INTO alerts (id,title,severity,source,timestamp,rule_id,device_id) VALUES ${chunk.map(() => '(?,?,?,?,?,?,?)').join(',')}`,
      ...chunk.flat(),
    );
    changed += chunk.length;
  }
  if (resolveIds.length) {
    await db.run(`UPDATE alerts SET resolved=1 WHERE id IN (${resolveIds.map(() => '?').join(',')})`, ...resolveIds);
    changed += resolveIds.length;
  }
  changed += await resolveOrphanAlerts();
  return changed;
}

// last_seen holds an ISO-8601 string, which sorts in chronological order, so the entire fleet
// is demoted in one statement rather than one per device.
async function refreshOffline() {
  const cutoff = new Date(Date.now() - config.offlineAfterMinutes * 60000).toISOString();
  const r = await db.run("UPDATE devices SET status='Offline', cpu=0, memory=0 WHERE managed=1 AND status<>'Offline' AND (last_seen IS NULL OR last_seen<?)", cutoff);
  return r.changes;
}
async function maintenance() {
  try {
    const a = await refreshOffline(), b = await evaluateRules();
    await db.run('DELETE FROM metrics WHERE at_ms<?', Date.now() - config.metricRetentionDays * 86400000);
    if (a || b) await broadcast();
  } catch (e) { console.error('maintenance error', e); }
}
setInterval(() => { void maintenance(); }, 30000).unref();

// ---------------------------------------------------------------- routing
const routes = [];
const route = (method, pattern, auth, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), auth, handler });
const send = (res, status, body) => { const s = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };
const fail = (status, error, extra) => Object.assign(new Error(error), { status, extra });

const failures = new Map();
route('POST', '/api/auth/login', null, ({ body, req }) => {
  const ip = req.socket.remoteAddress, rec = failures.get(ip) || { n: 0, until: 0 };
  if (rec.until > Date.now()) throw fail(429, 'Too many failed attempts. Wait a few minutes and try again.');
  const u = String(body.username || '').trim(), p = String(body.password || '');
  if (u && p && u.toLowerCase() === String(config.adminUsername).toLowerCase() && safeEq(p, config.adminPassword)) {
    failures.delete(ip);
    return { username: config.adminUsername, role: 'Administrator', token: signJwt({ sub: config.adminUsername, role: 'Administrator' }, 8) };
  }
  rec.n++; if (rec.n >= 8) { rec.until = Date.now() + 5 * 60000; rec.n = 0; } failures.set(ip, rec);
  throw fail(401, 'Invalid username or password.');
});
route('GET', '/health', null, () => ({ status: 'ok', service: 'DigitalMonitoringSystem', version: '2.0' }));
route('GET', '/api/dashboard', 'admin', () => buildDashboard());
route('GET', '/api/system/overview', 'admin', async () => { const s = await buildDashboard(); return { serviceName: 'DigitalMonitoringSystem', status: s.openAlerts === 0 ? 'Healthy' : 'Degraded', lastSyncUtc: now(), summary: s }; });

const deviceFull = (d) => ({ ...deviceRow(d), vendor: d.vendor, platform: d.platform, disk: d.disk, lastSeen: d.last_seen, isManaged: !!d.managed });
route('GET', '/api/devices', 'admin', async () => (await db.all('SELECT * FROM devices ORDER BY lower(hostname)')).map(deviceFull));
route('GET', '/api/devices/:id', 'admin', async ({ params }) => { const d = await db.get('SELECT * FROM devices WHERE id=?', params.id); if (!d) throw fail(404, 'Device not found.'); return deviceFull(d); });
route('DELETE', '/api/devices/:id', 'admin', async ({ params }) => {
  const d = await db.get('SELECT id FROM devices WHERE id=?', params.id); if (!d) throw fail(404, 'Device not found.');
  await db.run('DELETE FROM metrics WHERE device_id=?', d.id); await db.run('DELETE FROM assignments WHERE device_id=?', d.id);
  await db.run('DELETE FROM devices WHERE id=?', d.id); await evaluateRules(); await broadcast();
  return { deviceId: d.id, status: 'removed' };
});
route('GET', '/api/devices/:id/metrics', 'admin', async ({ params, query }) => {
  if (!await db.get('SELECT 1 FROM devices WHERE id=?', params.id)) throw fail(404, 'Device not found.');
  const win = Math.min(Math.max(parseInt(query.get('windowMinutes')) || 60, 1), 10080), max = Math.min(Math.max(parseInt(query.get('maxSamples')) || 120, 1), 1000);
  const rows = (await db.all('SELECT * FROM metrics WHERE device_id=? AND at_ms>=? ORDER BY at_ms DESC LIMIT ?', params.id, Date.now() - win * 60000, max)).reverse();
  const avg = (k) => (rows.length ? Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 10) / 10 : 0);
  const peak = (k) => (rows.length ? Math.max(...rows.map((r) => r[k])) : 0);
  return { deviceId: params.id, windowMinutes: win, sampleCount: rows.length, avgCpu: avg('cpu'), avgMemory: avg('memory'), peakCpu: peak('cpu'), peakMemory: peak('memory'),
    samples: rows.map((r) => ({ id: String(r.id), deviceId: r.device_id, cpu: r.cpu, memory: r.memory, disk: r.disk, capturedAt: r.at, capturedAtEpochMs: r.at_ms })) };
});
route('POST', '/api/devices/enroll', 'admin', async ({ body, req }) => {
  const hostname = String(body.hostname || '').trim(), ip = String(body.ipAddress || '').trim();
  if (!hostname || !ip) throw fail(400, 'Device enrollment requires hostname and IP address.');
  if (hostname.length > 100 || !/^[\w.\- ]+$/.test(hostname)) throw fail(400, 'The hostname contains characters that are not allowed.');
  if (!net.isIP(ip)) throw fail(400, 'The IP address is not a valid IPv4 or IPv6 address.');
  const clean = (v) => String(v || '').trim().slice(0, 100);
  const existing = await db.get('SELECT * FROM devices WHERE lower(hostname)=lower(?)', hostname);
  if (existing && !existing.managed) {
    throw fail(409, 'This hostname belongs to a demo-only inventory record. Enroll the actual computer using its verified hostname.');
  }
  let id, reEnrolled = false, status = 'Managed';
  if (existing) { // the same computer enrolled again: keep its history, refresh details, new token
    id = existing.id; reEnrolled = true; status = existing.status;
    await db.run("UPDATE devices SET ip=?, vendor=COALESCE(NULLIF(?,''),vendor), platform=COALESCE(NULLIF(?,''),platform), location=COALESCE(NULLIF(?,''),location), managed=1 WHERE id=?",
      ip, clean(body.vendor), clean(body.platform), clean(body.location), id);
  } else {
    id = uid('DEV');
    await db.run('INSERT INTO devices (id,hostname,ip,vendor,platform,location,status,last_seen,managed,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)',
      id, hostname, ip, clean(body.vendor), clean(body.platform), clean(body.location), 'Managed', now(), now());
  }
  const enrollmentToken = await issueDeviceToken(id); await broadcast();
  return { id, hostname: existing ? existing.hostname : hostname, status, isManaged: true, policyState: 'Pending', enrollmentToken, apiBaseUrl: baseUrl(req), reEnrolled };
});
route('POST', '/api/devices/:id/token', 'admin', async ({ params, req }) => {
  const d = await db.get('SELECT * FROM devices WHERE id=?', params.id); if (!d) throw fail(404, 'Device not found.');
  if (!d.managed) throw fail(409, 'Demo-only inventory records cannot receive monitoring tokens.');
  return { deviceId: d.id, hostname: d.hostname, enrollmentToken: await issueDeviceToken(d.id), apiBaseUrl: baseUrl(req) };
});
route('POST', '/api/devices/:id/heartbeat', 'adminOrDevice', async ({ params, body, auth }) => {
  if (auth.role === 'Device' && auth.deviceId !== params.id) throw fail(403, 'This token belongs to a different device.');
  const d = await db.get('SELECT * FROM devices WHERE id=?', params.id); if (!d) throw fail(404, 'Device not found. It may have been removed; re-enroll it.');
  if (!d.managed) throw fail(409, 'Demo-only inventory records cannot report monitoring data.');
  const pct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  const cpu = pct(body.cpu), memory = pct(body.memory), disk = pct(body.disk), t = Date.now(), at = new Date(t).toISOString();
  await db.run('INSERT INTO metrics (device_id,cpu,memory,disk,at_ms,at) VALUES (?,?,?,?,?,?)', d.id, cpu, memory, disk, t, at);
  await db.run("UPDATE devices SET cpu=?, memory=?, disk=?, status='Online', last_seen=? WHERE id=?", cpu, memory, disk, at, d.id);
  const before = new Set((await db.all('SELECT id FROM alerts WHERE resolved=0')).map((a) => a.id));
  await evaluateRules();
  const created = (await db.all('SELECT id FROM alerts WHERE resolved=0 AND device_id=?', d.id)).map((a) => a.id).filter((i) => !before.has(i));
  await broadcast();
  return { deviceId: d.id, status: 'Online', lastSeen: at, sampleCount: (await db.get('SELECT COUNT(*) c FROM metrics WHERE device_id=?', d.id)).c, triggeredAlertIds: created };
});

route('GET', '/api/alerts', 'admin', async () => (await db.all('SELECT * FROM alerts WHERE resolved=0 ORDER BY timestamp DESC')).map(alertRow));
route('POST', '/api/alerts/:id/acknowledge', 'admin', async ({ params }) => {
  if (!await db.get('SELECT 1 FROM alerts WHERE id=?', params.id)) throw fail(404, 'Alert not found.');
  await db.run('UPDATE alerts SET acknowledged=1 WHERE id=?', params.id); await broadcast(); return { alertId: params.id, status: 'acknowledged' };
});

route('GET', '/api/policies', 'admin', async () => (await buildDashboard()).policies);
route('GET', '/api/devices/:id/policies', 'admin', async ({ params }) => (await db.all('SELECT * FROM assignments WHERE device_id=?', params.id)).map((a) => ({ id: a.id, deviceId: a.device_id, policyId: a.policy_id, state: a.state, enforcedBy: a.enforced_by, enforcedAt: a.enforced_at, message: a.message })));
route('POST', '/api/devices/:deviceId/policies/:policyId/enforce', 'admin', async ({ params, auth }) => {
  const d = await db.get('SELECT * FROM devices WHERE id=?', params.deviceId), p = await db.get('SELECT * FROM policies WHERE id=?', params.policyId);
  if (!d || !p) throw fail(400, 'Device or policy was not found.', { status: 'rejected' });
  if (!d.managed) throw fail(400, 'Only managed devices can receive policies.', { status: 'rejected' });
  const message = `${p.name} recorded as assigned to ${d.hostname}. Operating-system enforcement depends on the agent version.`;
  await db.run("INSERT INTO assignments (id,device_id,policy_id,state,enforced_by,enforced_at,message) VALUES (?,?,?,'Assigned',?,?,?) ON CONFLICT(device_id,policy_id) DO UPDATE SET state='Assigned', enforced_by=excluded.enforced_by, enforced_at=excluded.enforced_at, message=excluded.message",
    uid('ASG'), d.id, p.id, auth.username, now(), message);
  await db.run("UPDATE policies SET status='Active', updated_at=? WHERE id=?", now(), p.id); await broadcast();
  return { deviceId: d.id, policyId: p.id, status: 'Assigned', message };
});
route('DELETE', '/api/devices/:deviceId/policies/:policyId/assign', 'admin', async ({ params }) => {
  const r = await db.run('DELETE FROM assignments WHERE device_id=? AND policy_id=?', params.deviceId, params.policyId);
  if (!r.changes) throw fail(404, 'That policy is not assigned to the device.'); await broadcast(); return { status: 'unassigned' };
});

const ruleRow = (r) => ({ id: r.id, name: r.name, metric: r.metric, threshold: r.threshold, durationMinutes: r.duration_minutes, severity: r.severity, enabled: !!r.enabled, updatedAt: r.updated_at });
function validateRule(b) {
  const metric = String(b.metric || '').toLowerCase(), severity = ['High', 'Medium', 'Info'].find((s) => s.toLowerCase() === String(b.severity || '').toLowerCase());
  if (!String(b.name || '').trim()) throw fail(400, 'Rule name is required.');
  if (!['cpu', 'memory', 'disk', 'offline'].includes(metric)) throw fail(400, 'Metric must be cpu, memory, disk or offline.');
  if (!severity) throw fail(400, 'Severity must be High, Medium or Info.');
  const threshold = Math.round(Number(b.threshold)), dur = Math.round(Number(b.durationMinutes ?? 0));
  if (!(threshold >= 1) || (metric !== 'offline' && threshold > 100)) throw fail(400, 'Threshold is out of range.');
  return [String(b.name).trim(), metric, threshold, Math.max(0, dur || 0), severity, b.enabled === false ? 0 : 1];
}
route('GET', '/api/alert-rules', 'admin', async () => (await db.all('SELECT * FROM rules ORDER BY name')).map(ruleRow));
route('POST', '/api/alert-rules', 'admin', async ({ body }) => { const id = uid('RULE'); await db.run('INSERT INTO rules VALUES (?,?,?,?,?,?,?,?)', id, ...validateRule(body), now()); return ruleRow(await db.get('SELECT * FROM rules WHERE id=?', id)); });
route('PUT', '/api/alert-rules/:id', 'admin', async ({ params, body }) => {
  if (!await db.get('SELECT 1 FROM rules WHERE id=?', params.id)) throw fail(404, 'Rule not found.');
  await db.run('UPDATE rules SET name=?,metric=?,threshold=?,duration_minutes=?,severity=?,enabled=?,updated_at=? WHERE id=?', ...validateRule(body), now(), params.id);
  return ruleRow(await db.get('SELECT * FROM rules WHERE id=?', params.id));
});
route('DELETE', '/api/alert-rules/:id', 'admin', async ({ params }) => { if (!(await db.run('DELETE FROM rules WHERE id=?', params.id)).changes) throw fail(404, 'Rule not found.'); await evaluateRules(); await broadcast(); return { status: 'deleted' }; });

route('POST', '/api/mobile/pair', 'admin', async ({ body, req }) => {
  const code = `MDM-${crypto.randomInt(100000, 1000000)}`, expires = new Date(Date.now() + 600000).toISOString();
  await db.run('INSERT INTO pairings (id,code,device_name,platform,expires_at) VALUES (?,?,?,?,?)', uid('PAIR'), code, String(body.deviceName || 'Mobile Device').trim().slice(0, 100), String(body.platform || 'Android').trim().slice(0, 50), expires);
  const u = new URL(baseUrl(req));
  return { pairingCode: code, host: u.hostname, port: Number(u.port), fingerprint: `SHA256:MDM-LOCAL:${u.hostname}`, expiresAt: expires };
});
route('POST', '/api/mobile/pair/complete', null, async ({ body, req }) => {
  const rec = await db.get('SELECT * FROM pairings WHERE code=?', String(body.pairingCode || '').trim().toUpperCase());
  if (!rec) throw fail(400, 'Pairing code was not found.');
  if (rec.used) throw fail(400, 'Pairing code has already been used.');
  if (Date.parse(rec.expires_at) <= Date.now()) throw fail(400, 'Pairing code has expired.');
  const id = uid('DEV'), ip = String(body.ipAddress || 'Unknown').trim().slice(0, 64);
  await db.run("INSERT INTO devices (id,hostname,ip,vendor,platform,location,status,last_seen,managed,created_at) VALUES (?,?,?,'Mobile',?,?,'Online',?,1,?)",
    id, rec.device_name, ip, rec.platform, String(body.location || 'Mobile').trim().slice(0, 100), now(), now());
  await db.run('UPDATE pairings SET used=1, device_id=? WHERE id=?', id, rec.id); await broadcast();
  return { deviceId: id, deviceName: rec.device_name, enrollmentToken: await issueDeviceToken(id), apiBaseUrl: baseUrl(req) };
});

// ---------------------------------------------------------------- server
async function authenticate(req, url) {
  const dev = req.headers['x-device-token'];
  const header = String(req.headers.authorization || '');
  const deviceToken = dev || (/^Device\s+/i.test(header) ? header.replace(/^Device\s+/i, '') : null);
  if (deviceToken) { const id = await verifyDeviceToken(deviceToken); return id ? { role: 'Device', deviceId: id } : null; }
  const jwt = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('access_token');
  const body = verifyJwt(jwt);
  return body && body.role === 'Administrator' ? { role: 'Administrator', username: body.sub } : null;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Dashboard files are missing (public/index.html).'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Token', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }); return res.end(); }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const a = await authenticate(req, url); if (!a || a.role !== 'Administrator') return send(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: dashboard\ndata: ${JSON.stringify(await buildDashboard())}\n\n`);
      clients.add(res); const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); }); return;
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') return serveStatic(req, res, url.pathname);
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Not found.' });
    let auth = null;
    if (r.auth) {
      auth = await authenticate(req, url);
      if (!auth) return send(res, 401, { error: 'Unauthorized' });
      if (r.auth === 'admin' && auth.role !== 'Administrator') return send(res, 403, { error: 'Administrator access required.' });
    }
    let body = {};
    if (['POST', 'PUT'].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1e6) throw fail(413, 'Request too large.'); chunks.push(c); }
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { throw fail(400, 'Request body is not valid JSON.'); } }
    }
    const params = r.re.exec(url.pathname).groups || {};
    send(res, 200, await r.handler({ req, body, params, query: url.searchParams, auth }));
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e); send(res, 500, { error: 'Internal server error.' });
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Close the other copy of this program (or change "port" in config.json).` : e.message);
  process.exit(1);
});

// Prepare storage and confirm it answers before accepting any traffic, so a bad connection
// string surfaces as a clear message rather than as 500s on the first page load.
async function startServer() {
  console.log('==============================================================');
  console.log(' DIGITAL MONITORING SYSTEM - MUKONO DISTRICT LOCAL GOVERNMENT');
  console.log('==============================================================');
  try {
    await db.bootstrap();
    await db.get('SELECT 1');
    await seedAll();
  } catch (e) {
    console.error(` The ${db.kind} database could not be opened: ${db.describe}`);
    console.error(` ${e.message}`);
    process.exit(1);
  }
  if (db.kind === 'postgres' && !process.env.JWT_SECRET) {
    console.warn('');
    console.warn(' !  DATABASE_URL is set but JWT_SECRET is not.');
    console.warn(' !  Every server sharing this database must use the SAME JWT_SECRET, or a');
    console.warn(' !  sign-in on one copy will be rejected by the other. Set JWT_SECRET on all');
    console.warn(' !  of them to a long random value.');
    console.warn('');
  }
  console.log(` Database        : ${db.kind} at ${db.describe}`);
  console.log(` Open on this computer : http://localhost:${config.port}`);
  console.log(` Open from the network : http://${lanIp()}:${config.port}`);
  console.log(` Administrator login   : ${config.adminUsername} / ${config.adminPassword === defaults.adminPassword ? config.adminPassword + '   (change it in config.json)' : '(set in config.json)'}`);
  console.log(' Keep this window open. Press Ctrl+C to stop.');
  server.listen(config.port, '0.0.0.0');
  void maintenance();
}
void startServer();

module.exports = { server, db, config };
