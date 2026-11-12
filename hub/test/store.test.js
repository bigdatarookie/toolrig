import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { recoveryPlan } from '../src/native.js';
import { AvailabilityService } from '../src/service.js';

const now = Date.now();
const context = { seat: 'support@toolrig', qitem: 'qitem-1', conversationId: 'native-conversation',
  cwd: '/work', configRef: '/config', permissions: 'builtin:yolo', model: 'fixed-model', effort: 'high',
  affectedCohort: ['support@toolrig', 'peer@opentour'] };
const decision = { action: 'wait', target: 'b', readyAt: new Date(now + 60000).toISOString() };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'toolrig-test-'));
  const path = join(dir, 'availability.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path };
}
test('restart retains pending native continuation/cohort and does not clear at reset', t => {
  const { path } = setup(t);
  let s = new Store(path);
  const op = s.reserve('/shared-home', decision, context, now); s.close();
  s = new Store(path);
  assert.deepEqual(s.pending('/shared-home'), op);
  const plan = recoveryPlan(op, now + 120000);
  assert.equal(plan.wake, null);
  assert.equal(s.pending('/shared-home').state, 'pending');
  s.close();
});
test('concurrent processes share one operation and preserve both native continuations', async t => {
  const { path } = setup(t);
  const module = new URL('../src/store.js', import.meta.url).href;
  const invoke = i => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {Store} from ${JSON.stringify(module)}; const s=new Store(${JSON.stringify(path)});
     const op=s.reserve('/shared-home',${JSON.stringify(decision)},${JSON.stringify({ ...context, seat: 's' + i, qitem: 'q' + i })});
     console.log(op.id);s.close();`]);
  const [a, b] = await Promise.all([invoke(1), invoke(2)]);
  assert.equal(a.stdout, b.stdout);
  const s = new Store(path);
  assert.equal(s.pending('/shared-home').waiters.length, 2);
  s.close();
});
test('only verified account/native move/new useful turn can complete operation', t => {
  const { path } = setup(t); const s = new Store(path);
  const op = s.reserve('/shared-home', decision, context, now);
  for (const evidence of [{}, { accountId: 'b', nativeVerdict: 'moved', usefulToolTurn: false },
    { accountId: 'wrong', nativeVerdict: 'moved', usefulToolTurn: true, observedAt: new Date(now + 1).toISOString() }]) {
    assert.throws(() => s.finish(op.id, evidence), /continuation_not_verified/);
  }
  assert.equal(s.pending('/shared-home').state, 'pending');
  s.finish(op.id, { accountId: 'b', nativeVerdict: 'moved', usefulToolTurn: true, observedAt: new Date(now + 1000).toISOString() });
  assert.equal(s.pending('/shared-home'), null); s.close();
});
test('registry rejects secret-shaped extra fields', t => {
  const { path } = setup(t); const s = new Store(path);
  assert.throws(() => s.register({ accountId: 'a', token: 'private' })); s.close();
});
test('one account quota shared across homes; old response cannot replace new observation', t => {
  const { path } = setup(t); const s = new Store(path);
  s.observe({ accountId: 'a', observedAt: '2026-11-12T16:00:00Z', home: 'one' });
  s.observe({ accountId: 'a', observedAt: '2026-11-12T15:00:00Z', home: 'two' });
  assert.equal(Object.keys(s.snapshots()).length, 1);
  assert.equal(s.snapshots().a.home, 'one'); s.close();
});
test('service rejects a provider reporting a different configured home', async t => {
  const { dir, path } = setup(t); const s = new Store(path);
  const service = new AvailabilityService({ home: dir, store: s, reader: {
    read: async () => ({ account: {}, usage: {}, home: '/tmp', observedAt: new Date(now).toISOString() }),
  } });
  await assert.rejects(service.status(), /provider_home_mismatch/); s.close();
});
