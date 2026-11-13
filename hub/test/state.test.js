import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StateTool } from '../src/state/tool.js';
import { CursorCache } from '../src/state/cache.js';
import { sourceCommands } from '../src/state/native.js';
const request = { rig: 'fixture', project: 'project', filter: { states: 'active' } };
const time = Date.parse('2026-11-13T11:00:00Z');
function task(id, extra = {}) {
  return { qitemId: id, destinationSession: 'owner@fixture', state: 'in-progress', tags: ['project:project'],
    tsCreated: new Date(time - 10000).toISOString(), tsUpdated: new Date(time).toISOString(), summary: 'native work', ...extra };
}
function setup(t) {
  let now = time;
  const root = mkdtempSync(join(tmpdir(), 'toolrig-state-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new CursorCache(root, { clock: () => now, ttlMs: 10000, maxEntries: 3 });
  const data = { identity: { identity: { rigName: 'fixture', sessionName: 'owner@fixture' } }, version: '0.7.7 (fixture)',
    seats: { entries: [{ logicalId: 'owner', canonicalSessionName: 'owner@fixture', lifecycleState: 'running',
      sessionStatus: 'running', intentionallyStopped: false, agentActivity: { state: 'idle', sampledAt: 'volatile', stale: false } }],
      totalNodes: 1, truncated: false }, queue: [task('a')] };
  const calls = [];
  const tool = new StateTool({ cache, clock: () => now, run: async args => {
    calls.push(args);
    const name = args[0] === 'whoami' ? 'identity' : args[0] === '--version' ? 'version' : args[0] === 'ps' ? 'seats' : 'queue';
    if (data[name] instanceof Error) throw data[name];
    if (typeof data[name] === 'string') return data[name];
    return JSON.stringify(data[name]);
  } });
  const snap = cursor => tool.snapshot({ ...request, ...(cursor ? { cursor } : {}) });
  return { data, calls, tool, cache, root, snap, advance: ms => { now += ms; } };
}
test('baseline -> unchanged ignores observation churn, exposes freshness and uses only supported metadata reads', async t => {
  const f = setup(t), a = await f.snap();
  assert.equal(a.status, 'ok'); assert.equal(a.baseline.tasks.a.owner, 'owner@fixture');
  f.data.seats.entries[0].agentActivity.sampledAt = 'new sample';
  const b = await f.snap(a.cursor);
  assert.equal(b.changed, false); assert.equal(b.baseline, undefined); assert.equal(b.delta, undefined);
  assert.equal(b.coverage.atomic, false); assert.equal(a.cost.nativeCalls, 4);
  assert.deepEqual(Object.keys(b).sort(), ['changed', 'coverage', 'cursor', 'observedAt']);
  assert(f.calls.some(a => a.join(' ') === sourceCommands.queue.join(' ')));
  assert(f.calls.every(a => !a.includes('--full') && !a.includes('capture') && !a.includes('show')));
});
test('state, owner, blocker and activity changes return precise native fields and scoped source refs', async t => {
  const f = setup(t), a = await f.snap();
  f.data.queue.push(task('blocker', { destinationSession: 'reviewer@fixture' }));
  f.data.queue[0] = task('a', { state: 'blocked', blockedOn: 'blocker' });
  f.data.seats.entries[0].agentActivity.state = 'running';
  const b = await f.snap(a.cursor);
  const fields = b.delta.changed.find(c => c.id === 'a').fields;
  assert.equal(fields.state.to, 'blocked'); assert.equal(fields.blocker.to.owner, 'reviewer@fixture');
  assert.equal(fields.blocker.to.since, null); assert.equal(b.delta.added[0].value.id, 'blocker');
  assert.equal(b.delta.changed.find(c => c.kind === 'seats').fields.activity.to.state, 'running');
});
test('terminal handoff leaves active projection but current native final state remains visible; removal never asserts deletion', async t => {
  const f = setup(t), a = await f.snap();
  f.data.queue[0] = task('a', { state: 'done', handedOffTo: 'consumer@fixture', closureReason: 'handed_off_to' });
  const b = await f.snap(a.cursor);
  assert.equal(b.delta.removed[0].id, 'a'); assert(b.delta.removed[0].meaning.includes('deletion_not_established'));
  assert.equal(b.critical[0].state, 'done'); assert.equal(b.critical[0].handoff.to, 'consumer@fixture');
});
test('new filtered terminal, failure, cancellation and source-tagged human gate remain visible', async t => {
  for (const state of ['canceled', 'failed', 'handed-off', 'denied']) {
    const f = setup(t), a = await f.snap();
    f.data.queue.push(task('new-final', { state }));
    const b = await f.snap(a.cursor); assert.equal(b.changed, true); assert.equal(b.critical[0].state, state);
  }
  const f = setup(t), a = await f.snap();
  f.data.queue[0].tags.push('gate:human');
  assert.equal((await f.snap(a.cursor)).critical[0].humanGate, 'source_tagged');
});
test('native stop/cancel activity is retained and missing/stale evidence is explicit', async t => {
  const f = setup(t), a = await f.snap();
  Object.assign(f.data.seats.entries[0], { intentionallyStopped: true, lifecycleState: 'stopped' });
  f.data.seats.entries[0].agentActivity = { state: 'unknown', reason: 'stop', stale: true };
  const b = await f.snap(a.cursor);
  assert.equal(b.delta.changed[0].fields.stopped.to, true);
  assert.deepEqual(b.coverage.staleActivity, ['owner@fixture']);
});
test('disappearance is projection absence; a different project is never leaked', async t => {
  const f = setup(t), a = await f.snap(); f.data.queue = [task('private', { tags: ['project:other'], summary: 'not returned' })];
  const b = await f.snap(a.cursor); assert.equal(b.delta.removed[0].id, 'a'); assert.equal(b.critical.length, 0);
  assert(!JSON.stringify(b).includes('not returned'));
});
test('consumer/scope/filter/source-version mismatch and lost/expired cursor explicitly reset to baseline', async t => {
  const f = setup(t), a = await f.snap();
  for (const input of [
    { ...request, project: 'other' }, { ...request, filter: { states: 'all' } },
  ]) assert.equal((await f.tool.snapshot({ ...input, cursor: a.cursor })).reset_required, true);
  f.data.identity.identity.sessionName = 'another@fixture'; assert.equal((await f.snap(a.cursor)).reset_required, true);
  f.data.identity.identity.sessionName = 'owner@fixture'; f.data.version = '0.7.8 (new)';
  assert.equal((await f.snap(a.cursor)).reset_required, true);
  assert.equal((await f.snap('missing')).reset_required, true);
  assert.equal((await f.tool.snapshot({ ...request, cursor: '' })).reset_required, true);
  f.data.version = '0.7.7 (fixture)'; f.advance(10001);
  assert.equal((await f.snap(a.cursor)).reset_required, true);
});
test('partial, invalid JSON, schema change, timeout and capped history never imply healthy empty or advance comparison', async t => {
  for (const bad of [new Error('daemon unavailable'), '{broken', {}, [task('a', { state: 'unknown-new-state' })],
    Array.from({ length: 1000 }, (_, i) => task(String(i)))]) {
    const f = setup(t), a = await f.snap(); f.data.queue = bad;
    const b = await f.snap(a.cursor);
    assert.equal(b.status, 'partial'); assert.equal(b.changed, null); assert.equal(b.cursor, null); assert.equal(b.delta, undefined);
    f.data.queue = [task('a')]; assert.equal((await f.snap(a.cursor)).changed, false);
  }
});
test('truncated ps, version failure and identity failure cannot look like unchanged', async t => {
  const f = setup(t), a = await f.snap(); f.data.seats.truncated = true;
  assert.equal((await f.snap(a.cursor)).changed, null);
  f.data.identity = new Error('private error'); await assert.rejects(f.snap(), /identity_unavailable/);
});
test('cross-rig and forged filter are rejected before any queue or node read', async t => {
  const f = setup(t);
  await assert.rejects(f.tool.snapshot({ ...request, rig: 'other' }), /scope_not_supported/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.tool.snapshot({ ...request, filter: { states: 'all', body: true } }));
});
test('body-bearing source response fails closed; payload is neither returned nor cached', async t => {
  const f = setup(t); f.data.queue[0].body = 'DO_NOT_RETURN';
  const a = await f.snap(); assert.equal(a.status, 'partial'); assert(!JSON.stringify(a).includes('DO_NOT_RETURN'));
  assert.equal(readdirSync(f.root).length, 0);
});
test('cache isolates consumers, bounds entries, expires and refuses symlink cursor files', async t => {
  const f = setup(t); let a;
  for (let n = 0; n < 8; n++) { a = await f.snap(); f.advance(1); }
  const dir = join(f.root, readdirSync(f.root)[0]);
  assert(readdirSync(dir).length <= 3);
  const path = join(dir, a.cursor + '.json');
  assert(!readFileSync(path, 'utf8').includes('agentActivity'));
  unlinkSync(path); const secret = join(f.root, 'not-a-cursor'); writeFileSync(secret, 'DO_NOT_READ'); symlinkSync(secret, path);
  const b = await f.snap(a.cursor); assert.equal(b.reset_required, true); assert(!JSON.stringify(b).includes('DO_NOT_READ'));
});

test('immediate parent-child metadata survives without opening a body and owner filter narrows native queue source', async t => {
  const f = setup(t); f.data.queue[0].handedOffFrom = 'parent'; f.data.queue[0].sourceSession = 'sender@fixture';
  const result = await f.tool.snapshot({ ...request, filter: { states: 'active', seat: 'owner@fixture' } });
  assert.equal(result.baseline.tasks.a.parentItem, 'parent'); assert.equal(result.baseline.tasks.a.sender, 'sender@fixture');
  assert(f.calls.find(a => a.includes('--destination') && a.includes('owner@fixture')));
});
test('corrupt comparison cache resets instead of authorizing an unchanged claim', async t => {
  const f = setup(t), a = await f.snap();
  const dir = join(f.root, readdirSync(f.root)[0]), path = join(dir, a.cursor + '.json');
  const entry = JSON.parse(readFileSync(path, 'utf8')); entry.selected.tasks = {};
  writeFileSync(path, JSON.stringify(entry));
  assert.equal((await f.snap(a.cursor)).reset_required, true);
});

test('successful compact unchanged CLI read exits zero without status/source/cost envelope', async t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'rig'), `#!/usr/bin/env node
const a=process.argv.slice(2);let result;
if(a[0]==='whoami')result={identity:{rigName:'fixture',sessionName:'owner@fixture'}};
else if(a[0]==='--version'){console.log('0.7.7 (fixture)');process.exit(0);}
else if(a[0]==='ps')result={entries:[],totalNodes:0,truncated:false};
else if(a[0]==='queue')result=[];
else process.exit(1);
console.log(JSON.stringify(result));`, { mode: 0o700 });
  const exec = promisify(execFile), args = [fileURLToPath(new URL('../src/state-cli.js', import.meta.url)),
    '--rig','fixture','--project','project','--filter','active'];
  const opts = { env: { ...process.env, PATH: f.root + ':' + process.env.PATH,
    TOOLRIG_STATE_CACHE_DIR: join(f.root,'cli-cache') } };
  const first = JSON.parse((await exec(process.execPath, args, opts)).stdout);
  const second = JSON.parse((await exec(process.execPath, [...args,'--cursor',first.cursor], opts)).stdout);
  assert.equal(second.changed, false);
  assert.deepEqual(Object.keys(second).sort(), ['changed', 'coverage', 'cursor', 'observedAt']);
});
