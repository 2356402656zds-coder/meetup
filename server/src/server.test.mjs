import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('local API creates an isolated tournament and applies TV actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poker-clock-pro-'));
  const port = 19000 + Math.floor(Math.random() * 500);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_FILE: join(dir, 'test.sqlite') }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const template = (await (await fetch(`${base}/api/templates`)).json())[0];
    const created = await (await fetch(`${base}/api/tournaments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'smoke', tableId: 'A01', templateId: template.id, initialPlayers: 10 }) })).json();
    const tid = created.tournament.id;
    const started = await (await fetch(`${base}/api/tournaments/${tid}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })).json();
    assert.equal(started.state.status, 'RUNNING');
    const edited = await (await fetch(`${base}/api/tournaments/${tid}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'edit_level', sb: 150, bb: 300, ante: 50, minutes: 1 }) })).json();
    assert.equal(edited.level.bb, 300); assert.equal(edited.state.status, 'PAUSED');
    const isolated = await (await fetch(`${base}/api/tv/state?tableId=A02`)).json();
    assert.equal(isolated.snapshot, null);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?tableId=A01`);
    const firstMessage = await new Promise((resolve, reject) => { ws.onmessage = e => resolve(JSON.parse(e.data)); ws.onerror = reject; setTimeout(() => reject(new Error('websocket timeout')), 1000); });
    assert.equal(firstMessage.type, 'snapshot'); assert.equal(firstMessage.table.id, 'A01'); ws.close();
  } finally { child.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); }
});
