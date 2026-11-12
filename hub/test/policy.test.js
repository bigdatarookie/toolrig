import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, availability, choose } from '../src/policy.js';

const now = Date.parse('2026-11-12T16:00:00Z');
const reset = minutes => new Date(now + minutes * 60000).toISOString();
export function snapshot(accountId = 'a', remaining = 99, minutes = 10) {
  return { accountId, observedAt: new Date(now).toISOString(), ordinaryUsageAllowed: true,
    buckets: { codex: { windows: [{ remainingPercent: remaining, resetsAt: reset(minutes) }] } } };
}
export function entry(accountId = 'a', changes = {}) {
  return { accountId, authorized: true, authState: 'ready', authRef: 'native-profile:' + accountId,
    grants: [{ project: 'toolrig', model: 'fixed-model', requiredBuckets: ['codex'] }], ...changes };
}
function decide(snapshots, entries = [entry(), entry('b')], extra = {}) {
  return choose({ currentId: 'a', project: 'toolrig', model: 'fixed-model', now, snapshots, entries, ...extra });
}
test('raw usedPercent=1 => remaining=99; only allowlisted metadata leaves reader', () => {
  const raw = { account: { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' } },
    usage: { accountId: 'a', ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex',
      primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: now / 1000 + 600 } },
      rateLimitResetCredits: { id: 'do-not-leak' } }, observedAt: new Date(now).toISOString() };
  const safe = normalize(raw);
  assert.equal(safe.buckets.codex.windows[0].usedPercent, 1);
  assert.equal(safe.buckets.codex.windows[0].remainingPercent, 99);
  assert.equal(safe.buckets.codex.windows[0].resetsAt, reset(10));
  assert.match(safe.observedAtBangkok, /23:00:00/);
  assert.equal(safe.providerObservedAt, null);
  assert.doesNotMatch(JSON.stringify(safe), /private@|do-not-leak/);
});
test('above threshold continues; exactly 5 chooses authorized compatible alternative', () => {
  assert.equal(decide({ a: snapshot('a', 6), b: snapshot('b') }).action, 'continue');
  assert.equal(decide({ a: snapshot('a', 5), b: snapshot('b') }).target, 'b');
});
test('5 with no alternative continues to zero; zero selects own confirmed reset', () => {
  const entries = [entry()];
  assert.equal(decide({ a: snapshot('a', 5) }, entries).action, 'continue');
  const d = decide({ a: snapshot('a', 0) }, entries);
  assert.equal(d.action, 'wait'); assert.equal(d.target, 'a'); assert.equal(d.readyAt, reset(10));
});
test('current zero uses confirmed target 1-5% before waiting on exhausted quota', () => {
  for (const remaining of [1, 5]) {
    const d = decide({ a: snapshot('a', 0), b: snapshot('b', remaining), c: snapshot('c', 0, 30) },
      [entry(), entry('b'), entry('c')]);
    assert.equal(d.action, 'transition_required');
    assert.equal(d.target, 'b');
    assert.equal(d.targetAvailability.state, 'low');
    assert.equal(d.targetAvailability.remainingPercent, remaining);
  }
});
test('provider-blocked current uses positive target; unknown/stale/denied low targets stay ineligible', () => {
  const d = decide({ a: snapshot(), b: snapshot('b', 1) }, undefined, { providerLimit: true });
  assert.equal(d.action, 'transition_required');
  assert.equal(d.target, 'b');
  for (const change of [{ ordinaryUsageAllowed: null }, { ordinaryUsageAllowed: false },
    { observedAt: reset(-3) }, { observedAt: reset(1) }]) {
    const b = { ...snapshot('b', 1), ...change };
    const result = decide({ a: snapshot('a', 0), b });
    assert.equal(result.action, 'wait');
    assert.equal(result.target, 'a');
  }
});
test('multi-window earliest target uses max of all exhausted applicable windows', () => {
  const a = snapshot('a', 0, 10);
  a.buckets.codex.windows.push({ remainingPercent: 0, resetsAt: reset(60) });
  const b = snapshot('b', 0, 20);
  assert.equal(decide({ a, b }).target, 'b');
});
test('multiple required buckets prevent selecting a blocked model bucket', () => {
  const b = snapshot('b'); b.buckets.extra = { windows: [{ remainingPercent: 0, resetsAt: reset(90) }] };
  const grant = entry('b'); grant.grants[0].requiredBuckets.push('extra');
  assert.equal(decide({ a: snapshot('a', 0, 100), b }, [entry(), grant]).readyAt, reset(90));
});
test('unknown never becomes 0/100, guessed reset, or a target', () => {
  const a = snapshot('a', null); const b = snapshot('b', 0); b.buckets.codex.windows[0].resetsAt = null;
  assert.equal(decide({ a, b }).action, 'observe');
  assert.equal(decide({ a: snapshot('a', 0, -1), b }).action, 'gap');
  assert.equal(availability(snapshot(), ['missing'], now).state, 'unknown');
});
test('null ordinaryUsageAllowed and stale/future observations cannot imply availability', () => {
  for (const change of [{ ordinaryUsageAllowed: null }, { observedAt: reset(-3) }, { observedAt: reset(1) }]) {
    assert.equal(availability({ ...snapshot(), ...change }, ['codex'], now).state, 'unknown');
  }
});
test('elapsed reset requires reobservation, provider denial is not recovery', () => {
  const a = snapshot('a', 0, -1);
  assert.equal(decide({ a }, [entry()]).action, 'gap');
  const denied = { ...snapshot(), ordinaryUsageAllowed: false };
  assert.equal(availability(denied, ['codex'], now).readyAt, null);
});
test('provider limit event enters blocked path even when last read had headroom', () => {
  assert.equal(decide({ a: snapshot() }, [entry()], { providerLimit: true }).action, 'gap');
});
test('projects/models/auth state are exact grants, not inferred from home', () => {
  for (const changes of [{ authorized: false }, { authState: 'unknown' }, { authRef: null },
    { grants: [{ project: 'another', model: 'fixed-model', requiredBuckets: ['codex'] }] },
    { grants: [{ project: 'toolrig', model: 'different', requiredBuckets: ['codex'] }] }]) {
    assert.equal(decide({ a: snapshot('a', 5), b: snapshot('b') }, [entry(), entry('b', changes)]).action, 'continue');
  }
});
test('spend control and workspace denial never borrow another limit reset', () => {
  for (const change of [{ spendControlReached: true }, { rateLimitReachedType: 'workspace_owner_credits_depleted' }]) {
    const a = snapshot('a', 0); Object.assign(a.buckets.codex, change);
    assert.equal(availability(a, ['codex'], now).readyAt, null);
  }
});
test('missing current registry produces precise observation gap', () => {
  assert.equal(decide({ a: snapshot('a', 0) }, []).reason, 'unknown_current_quota');
});
