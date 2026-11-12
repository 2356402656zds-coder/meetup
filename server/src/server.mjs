import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = process.env.DATABASE_FILE || join(DATA_DIR, 'poker-clock-pro.sqlite');
const PORT = Number(process.env.PORT || 8787);
await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'ADMIN', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS poker_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tv_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, binding_code TEXT NOT NULL UNIQUE, table_id TEXT REFERENCES poker_tables(id), last_seen_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blind_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blind_template_levels (id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES blind_templates(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, label TEXT NOT NULL, sb INTEGER NOT NULL, bb INTEGER NOT NULL, ante INTEGER NOT NULL DEFAULT 0, ante_type TEXT NOT NULL DEFAULT 'NONE', duration_seconds INTEGER NOT NULL, is_break INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, name TEXT NOT NULL, table_id TEXT NOT NULL REFERENCES poker_tables(id), template_id TEXT NOT NULL REFERENCES blind_templates(id), status TEXT NOT NULL DEFAULT 'DRAFT', created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS tournament_levels (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, label TEXT NOT NULL, sb INTEGER NOT NULL, bb INTEGER NOT NULL, ante INTEGER NOT NULL DEFAULT 0, ante_type TEXT NOT NULL DEFAULT 'NONE', duration_seconds INTEGER NOT NULL, is_break INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tournament_states (tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE, current_level INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'READY', ends_at INTEGER, remaining_ms INTEGER, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tournament_stats (tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE, initial_players INTEGER NOT NULL DEFAULT 0, remaining_players INTEGER NOT NULL DEFAULT 0, eliminated_players INTEGER NOT NULL DEFAULT 0, initial_entries INTEGER NOT NULL DEFAULT 0, reentries INTEGER NOT NULL DEFAULT 0, rebuys INTEGER NOT NULL DEFAULT 0, addons INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS operation_logs (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE, action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tournaments_table_status ON tournaments(table_id,status);`);

const nowIso = () => new Date().toISOString();
const q = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const json = (res, code, value) => { const body = JSON.stringify(value); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(body); };
const fail = (res, code, message) => json(res, code, { error: message });
const body = async req => { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 1_000_000) throw Error('request too large'); } return s ? JSON.parse(s) : {}; };
const id = () => randomUUID();

function seed() {
  if (!q('SELECT id FROM users LIMIT 1')) run('INSERT INTO users VALUES(?,?,?,?)', id(), 'admin', 'ADMIN', nowIso());
  if (!q('SELECT id FROM poker_tables LIMIT 1')) {
    const t = nowIso();
    for (const name of ['A01 TABLE', 'A02 TABLE', 'A03 TABLE', 'A04 TABLE']) run('INSERT INTO poker_tables VALUES(?,?,1,?)', name.slice(0, 3).replace('0', '0'), name, t);
  }
  if (!q('SELECT id FROM blind_templates LIMIT 1')) {
    const templateId = id(); run('INSERT INTO blind_templates VALUES(?,?,?)', templateId, '标准赛事 20 分钟', nowIso());
    [[100,200,0,20],[200,400,0,20],[300,600,100,20],[500,1000,100,20],[1000,2000,200,20]].forEach((v, i) => run('INSERT INTO blind_template_levels VALUES(?,?,?,?,?,?,?,?,?,?)', id(), templateId, i, `Level ${i + 1}`, v[0], v[1], v[2], v[2] ? 'ANTE' : 'NONE', v[3] * 60, 0));
    run('INSERT INTO blind_template_levels VALUES(?,?,?,?,?,?,?,?,?,?)', id(), templateId, 5, 'Break', 0, 0, 0, 'NONE', 10 * 60, 1);
  }
}
seed();

function getLevel(tournamentId, sequence) { return q('SELECT * FROM tournament_levels WHERE tournament_id=? AND sequence=?', tournamentId, sequence); }
function log(tournamentId, action, payload = {}) { run('INSERT INTO operation_logs VALUES(?,?,?,?,?)', id(), tournamentId, action, JSON.stringify(payload), nowIso()); }
function advance(tournamentId) {
  const st = q('SELECT * FROM tournament_states WHERE tournament_id=?', tournamentId);
  if (!st) return;
  const now = Date.now();
  let state = st;
  if (state.status === 'RUNNING' && state.ends_at && now >= state.ends_at) {
    let level = state.current_level;
    let ends = state.ends_at;
    while (ends <= now) {
      const next = getLevel(tournamentId, level + 1);
      if (!next) { run('UPDATE tournament_states SET status=?,ends_at=NULL,remaining_ms=0,version=version+1,updated_at=? WHERE tournament_id=?', 'COMPLETED', nowIso(), tournamentId); run('UPDATE tournaments SET status=?,completed_at=? WHERE id=?', 'COMPLETED', nowIso(), tournamentId); log(tournamentId, 'AUTO_COMPLETE'); return; }
      level += 1; ends += next.duration_seconds * 1000;
      log(tournamentId, 'AUTO_LEVEL', { level });
    }
    state = { ...state, current_level: level, ends_at: ends };
    run('UPDATE tournament_states SET current_level=?,ends_at=?,remaining_ms=?,version=version+1,updated_at=? WHERE tournament_id=?', level, ends, Math.max(0, ends - now), nowIso(), tournamentId);
  } else if (state.status === 'RUNNING') {
    run('UPDATE tournament_states SET remaining_ms=?,updated_at=? WHERE tournament_id=?', Math.max(0, state.ends_at - now), nowIso(), tournamentId);
  }
}
function snapshot(tournamentId) {
  advance(tournamentId);
  const t = q('SELECT * FROM tournaments WHERE id=?', tournamentId); if (!t) return null;
  const st = q('SELECT * FROM tournament_states WHERE tournament_id=?', tournamentId);
  const level = getLevel(tournamentId, st.current_level); const next = getLevel(tournamentId, st.current_level + 1); const stats = q('SELECT * FROM tournament_stats WHERE tournament_id=?', tournamentId);
  return { tournament: t, state: { ...st, remaining_ms: st.status === 'RUNNING' ? Math.max(0, st.ends_at - Date.now()) : st.remaining_ms }, level, next, stats };
}
function tableSnapshot(tableId) {
  const table = q('SELECT * FROM poker_tables WHERE id=?', tableId); if (!table) return null;
  const t = q("SELECT * FROM tournaments WHERE table_id=? AND status IN ('READY','RUNNING','PAUSED','BREAK') ORDER BY created_at DESC LIMIT 1", tableId);
  return { table, snapshot: t ? snapshot(t.id) : null };
}
function createTournament(input) {
  const table = q('SELECT * FROM poker_tables WHERE id=? AND enabled=1', input.tableId); if (!table) throw Error('牌桌不存在或已停用');
  if (q("SELECT id FROM tournaments WHERE table_id=? AND status IN ('READY','RUNNING','PAUSED','BREAK')", input.tableId)) throw Error('该牌桌已有进行中的比赛');
  const tpl = q('SELECT * FROM blind_templates WHERE id=?', input.templateId); if (!tpl) throw Error('盲注模板不存在');
  const levels = all('SELECT * FROM blind_template_levels WHERE template_id=? ORDER BY sequence', tpl.id); if (!levels.length) throw Error('盲注模板没有等级');
  const tournamentId = id(); const created = nowIso(); const players = Math.max(0, Number(input.initialPlayers || 0));
  run('INSERT INTO tournaments VALUES(?,?,?,?,?,?,?,?)', tournamentId, input.name || `${table.name} 比赛`, table.id, tpl.id, 'READY', created, null, null);
  levels.forEach(l => run('INSERT INTO tournament_levels VALUES(?,?,?,?,?,?,?,?,?,?)', id(), tournamentId, l.sequence, l.label, l.sb, l.bb, l.ante, l.ante_type, l.duration_seconds, l.is_break));
  run('INSERT INTO tournament_states VALUES(?,?,?,?,?,?,?)', tournamentId, 0, 'READY', null, levels[0].duration_seconds * 1000, 0, created);
  run('INSERT INTO tournament_stats VALUES(?,?,?,?,?,?,?,?)', tournamentId, players, players, 0, players, 0, 0, 0); log(tournamentId, 'CREATE', input); return snapshot(tournamentId);
}
function action(tournamentId, actionName, payload = {}) {
  advance(tournamentId); const s = snapshot(tournamentId); if (!s) throw Error('比赛不存在'); const st = s.state; const now = Date.now();
  if (actionName === 'start' || actionName === 'resume') { if (st.status === 'COMPLETED') throw Error('比赛已结束'); const remaining = Math.max(1000, Number(st.remaining_ms || (s.level.duration_seconds * 1000))); run('UPDATE tournament_states SET status=?,ends_at=?,remaining_ms=?,version=version+1,updated_at=? WHERE tournament_id=?', 'RUNNING', now + remaining, remaining, nowIso(), tournamentId); run('UPDATE tournaments SET status=?,started_at=COALESCE(started_at,?) WHERE id=?', 'RUNNING', nowIso(), tournamentId); log(tournamentId, actionName); }
  else if (actionName === 'pause') { const rem = st.status === 'RUNNING' ? Math.max(0, st.ends_at - now) : st.remaining_ms; run('UPDATE tournament_states SET status=?,ends_at=NULL,remaining_ms=?,version=version+1,updated_at=? WHERE tournament_id=?', 'PAUSED', rem, nowIso(), tournamentId); run('UPDATE tournaments SET status=? WHERE id=?', 'PAUSED', tournamentId); log(tournamentId, 'PAUSE', { remaining_ms: rem }); }
  else if (actionName === 'next' || actionName === 'prev') { const delta = actionName === 'next' ? 1 : -1; const nextIndex = Math.max(0, Math.min(all('SELECT sequence FROM tournament_levels WHERE tournament_id=? ORDER BY sequence', tournamentId).at(-1).sequence, st.current_level + delta)); const l = getLevel(tournamentId, nextIndex); run('UPDATE tournament_states SET current_level=?,status=?,ends_at=NULL,remaining_ms=?,version=version+1,updated_at=? WHERE tournament_id=?', nextIndex, l.is_break ? 'BREAK' : 'PAUSED', l.duration_seconds * 1000, nowIso(), tournamentId); run('UPDATE tournaments SET status=? WHERE id=?', l.is_break ? 'BREAK' : 'PAUSED', tournamentId); log(tournamentId, actionName, { level: nextIndex }); }
  else if (actionName === 'complete' || actionName === 'cancel') { const finalStatus = actionName === 'complete' ? 'COMPLETED' : 'CANCELLED'; run('UPDATE tournament_states SET status=?,ends_at=NULL,version=version+1,updated_at=? WHERE tournament_id=?', finalStatus, nowIso(), tournamentId); run('UPDATE tournaments SET status=?,completed_at=? WHERE id=?', finalStatus, nowIso(), tournamentId); log(tournamentId, actionName); }
  else if (actionName === 'edit_level') { const sb = Math.max(0, Number(payload.sb)); const bb = Math.max(0, Number(payload.bb)); const ante = Math.max(0, Number(payload.ante)); const durationSeconds = Math.max(60, Math.min(86400, Number(payload.minutes) * 60)); if (![sb, bb, ante, durationSeconds].every(Number.isFinite)) throw Error('盲注参数无效'); run('UPDATE tournament_levels SET sb=?,bb=?,ante=?,ante_type=?,duration_seconds=? WHERE tournament_id=? AND sequence=?', sb, bb, ante, ante ? 'ANTE' : 'NONE', durationSeconds, tournamentId, st.current_level); run('UPDATE tournament_states SET status=?,ends_at=NULL,remaining_ms=?,version=version+1,updated_at=? WHERE tournament_id=?', 'PAUSED', durationSeconds * 1000, nowIso(), tournamentId); run('UPDATE tournaments SET status=? WHERE id=?', 'PAUSED', tournamentId); log(tournamentId, actionName, { level: st.current_level, sb, bb, ante, durationSeconds }); }
  else if (['players','entries','reentries','rebuys','addons'].includes(actionName)) { const column = { players: 'remaining_players', entries: 'initial_entries', reentries: 'reentries', rebuys: 'rebuys', addons: 'addons' }[actionName]; const current = s.stats[column] || 0; const value = Math.max(0, current + Number(payload.delta || 0)); run(`UPDATE tournament_stats SET ${column}=? WHERE tournament_id=?`, value, tournamentId); if (actionName === 'players') run('UPDATE tournament_stats SET eliminated_players=MAX(0,initial_players-remaining_players) WHERE tournament_id=?', tournamentId); log(tournamentId, actionName, { delta: Number(payload.delta || 0), value }); }
  else throw Error('不支持的操作');
  return snapshot(tournamentId);
}

const clients = new Set(); const wsClients = new Set();
function wsFrame(text) { const payload = Buffer.from(text); if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]); if (payload.length < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(payload.length, 2); return Buffer.concat([h, payload]); } const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return Buffer.concat([h, payload]); }
function broadcast() { for (const c of clients) { const data = JSON.stringify({ type: 'snapshot', ...tableSnapshot(c.tableId) }); c.res.write(`event: snapshot\ndata: ${data}\n\n`); } for (const c of wsClients) { const data = JSON.stringify({ type: 'snapshot', ...tableSnapshot(c.tableId) }); try { c.socket.write(wsFrame(data)); } catch { wsClients.delete(c); } } }
setInterval(() => { for (const t of all("SELECT id FROM tournaments WHERE status IN ('READY','RUNNING','PAUSED','BREAK')")) advance(t.id); broadcast(); }, 1000).unref();

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const path = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  try {
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, service: 'Poker Clock Pro', now: Date.now() });
    if (req.method === 'GET' && path === '/api/tables') return json(res, 200, all('SELECT * FROM poker_tables ORDER BY id').map(t => ({ ...t, active: tableSnapshot(t.id) })));
    if (req.method === 'POST' && path === '/api/tables') { const b = await body(req); const tableId = String(b.id || '').trim().toUpperCase(); if (!/^[A-Z][0-9]{2}$/.test(tableId)) throw Error('牌桌编号需类似 A01'); run('INSERT INTO poker_tables VALUES(?,?,?,?)', tableId, b.name || `${tableId} TABLE`, b.enabled === false ? 0 : 1, nowIso()); return json(res, 201, q('SELECT * FROM poker_tables WHERE id=?', tableId)); }
    if (req.method === 'GET' && path === '/api/templates') return json(res, 200, all('SELECT * FROM blind_templates ORDER BY created_at DESC').map(t => ({ ...t, levels: all('SELECT * FROM blind_template_levels WHERE template_id=? ORDER BY sequence', t.id) })));
    if (req.method === 'POST' && path === '/api/templates') { const b = await body(req); const templateId = id(); run('INSERT INTO blind_templates VALUES(?,?,?)', templateId, b.name || '新模板', nowIso()); (b.levels || []).forEach((l, i) => run('INSERT INTO blind_template_levels VALUES(?,?,?,?,?,?,?,?,?,?)', id(), templateId, i, l.label || `Level ${i + 1}`, Number(l.sb || 0), Number(l.bb || 0), Number(l.ante || 0), l.anteType || 'NONE', Number(l.durationSeconds || 1200), l.isBreak ? 1 : 0)); return json(res, 201, q('SELECT * FROM blind_templates WHERE id=?', templateId)); }
    if (req.method === 'GET' && path === '/api/tournaments') return json(res, 200, all('SELECT * FROM tournaments ORDER BY created_at DESC').map(t => snapshot(t.id) || t));
    if (req.method === 'GET' && path === '/api/tournaments.csv') { const rows = all('SELECT t.name,t.table_id,t.status,t.created_at,t.started_at,t.completed_at,s.initial_players,s.initial_entries,s.remaining_players,s.reentries,s.rebuys,s.addons FROM tournaments t JOIN tournament_stats s ON s.tournament_id=t.id ORDER BY t.created_at DESC'); const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`; const csv = ['name,table,status,created_at,started_at,completed_at,initial_players,initial_entries,remaining_players,reentries,rebuys,addons', ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n'); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="poker-clock-tournaments.csv"', 'Access-Control-Allow-Origin': '*' }); return res.end(csv); }
    if (req.method === 'POST' && path === '/api/tournaments') return json(res, 201, createTournament(await body(req)));
    const tournamentMatch = path.match(/^\/api\/tournaments\/([^/]+)(?:\/action)?$/); if (tournamentMatch) { const tournamentId = tournamentMatch[1]; if (req.method === 'GET') return json(res, 200, snapshot(tournamentId) || { error: '比赛不存在' }); if (req.method === 'POST' && path.endsWith('/action')) { const b = await body(req); const result = action(tournamentId, b.action, b); broadcast(); return json(res, 200, result); } }
    if (req.method === 'GET' && path === '/api/tv/state') { const tableId = url.searchParams.get('tableId'); const result = tableSnapshot(tableId); if (!result) return fail(res, 404, '牌桌不存在'); return json(res, 200, result); }
    if (req.method === 'POST' && path === '/api/tv/bind') { const b = await body(req); const table = q('SELECT * FROM poker_tables WHERE id=?', b.tableId); if (!table) throw Error('牌桌不存在'); const deviceId = b.deviceId || id(); const code = b.bindingCode || id().slice(0, 6).toUpperCase(); run('INSERT INTO tv_devices VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET table_id=excluded.table_id,last_seen_at=excluded.last_seen_at', deviceId, b.name || 'Android TV', code, table.id, nowIso(), nowIso()); return json(res, 200, { deviceId, bindingCode: code, table }); }
    if (req.method === 'GET' && path === '/api/events') { const tableId = url.searchParams.get('tableId'); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' }); clients.add({ res, tableId }); res.write('event: ready\ndata: {}\n\n'); req.on('close', () => clients.delete([...clients].find(c => c.res === res))); return; }
    if (req.method === 'GET') { const html = await readFile(join(ROOT, 'public', 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length }); return res.end(html); }
    return fail(res, 404, 'Not found');
  } catch (e) { return fail(res, 400, e.message || 'Bad request'); }
}
if (process.argv.includes('--migrate-only')) { console.log(`Database ready: ${DB_FILE}`); process.exit(0); }
const server = http.createServer(route);
server.on('upgrade', (req, socket) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy(); const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); const client = { socket, tableId: url.searchParams.get('tableId') }; wsClients.add(client); socket.write(wsFrame(JSON.stringify({ type: 'snapshot', ...tableSnapshot(client.tableId) }))); socket.on('data', buf => { if ((buf[0] & 0x0f) === 0x8) socket.end(); else if ((buf[0] & 0x0f) === 0x9) socket.write(Buffer.from([0x8a, 0])); }); socket.on('close', () => wsClients.delete(client)); socket.on('error', () => wsClients.delete(client)); } catch { socket.destroy(); } });
server.listen(PORT, '0.0.0.0', () => console.log(`Poker Clock Pro server: http://0.0.0.0:${PORT}`));
