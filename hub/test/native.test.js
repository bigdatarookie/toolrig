import test from 'node:test';
import assert from 'node:assert/strict';
import { armWake } from '../src/native.js';

const now = Date.now();
function setup() {
  const operation = { id: 'op', decision: { target: 'b', readyAt: new Date(now + 60000).toISOString() },
    continuation: { seat: 's', qitem: 'q' }, wake: null };
  return { operation, store: { pending: () => operation,
    claimWake: () => { if (operation.wake) return false; operation.wake = 'arming'; return true; },
    markWake: (_id, state) => { operation.wake = state; } } };
}
test('native wake parks existing owned qitem once and survives lost response reconciliation', async () => {
  const { operation, store } = setup();
  let q = { destinationSession: 's', state: 'in-progress' };
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[1] === 'show') return q;
    q = { destinationSession: 's', state: 'blocked', blockedOn: 'external:availability:op' };
    throw new Error('response_lost');
  };
  await assert.rejects(armWake(store, '/home', 's', { run, now }), /wake_effect_unknown/);
  assert.equal(operation.wake, 'unknown');
  assert.equal((await armWake(store, '/home', 's', { run, now })).wake, 'already_parked');
  assert.equal(calls.filter(a => a[1] === 'block').length, 1);
  assert(calls.find(a => a[1] === 'block').includes('60s'));
});
test('wrong owner, stale reset and unknown business effect refuse a new park', async () => {
  const { operation, store } = setup();
  const run = async () => ({ destinationSession: 'other', state: 'in-progress' });
  await assert.rejects(armWake(store, '/home', 's', { run, now }), /wake_owner_mismatch/);
  const own = async () => ({ destinationSession: 's', state: 'in-progress' });
  await assert.rejects(armWake(store, '/home', 's', { run: own, now: now + 120000 }), /fresh_observation_required/);
  operation.wake = 'unknown';
  await assert.rejects(armWake(store, '/home', 's', { run: own, now }), /wake_effect_unknown/);
});
