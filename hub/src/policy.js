export const utc = seconds => Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
export const bangkok = value => value ? new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'long',
}).format(new Date(value)) : null;

function window(name, value) {
  const used = value?.usedPercent;
  const valid = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100;
  return { name, usedPercent: valid ? used : null, remainingPercent: valid ? 100 - used : null,
    windowDurationMins: value?.windowDurationMins ?? null, resetsAt: utc(value?.resetsAt) };
}

// Whitelist output: never persist email, credentials, raw provider errors,
// balances, reset-credit identifiers, upsells or private provider bodies.
export function normalize(raw) {
  const u = raw.usage;
  const buckets = u.rateLimitsByLimitId ?? { [u.rateLimits?.limitId ?? 'legacy']: u.rateLimits };
  return {
    accountId: u.accountId ?? null,
    workspaceName: raw.account.account?.workspaceName ?? null,
    accountType: raw.account.account?.type ?? null,
    planType: raw.account.account?.planType ?? null,
    ordinaryUsageAllowed: u.ordinaryUsageAllowed ?? null,
    source: 'codex:account/read+account/rateLimits/read',
    providerVersion: raw.providerVersion,
    identityObservedAt: raw.identityObservedAt, observedAt: raw.observedAt,
    observedAtBangkok: bangkok(raw.observedAt), providerObservedAt: null,
    home: raw.home,
    buckets: Object.fromEntries(Object.entries(buckets).map(([id, b]) => [id, {
      windows: ['primary', 'secondary'].filter(k => b?.[k] != null).map(k => window(k, b[k])),
      spendControlReached: b?.spendControlReached ?? null,
      rateLimitReachedType: b?.rateLimitReachedType ?? null,
      individualLimit: b?.individualLimit ? {
        remainingPercent: b.individualLimit.remainingPercent, resetsAt: utc(b.individualLimit.resetsAt),
      } : null,
    }])),
  };
}

// A grant explicitly names required quota buckets for this model. Never guess
// model->quota alias applicability from its display name or home path.
export function availability(snapshot, requiredBuckets, now, maxAgeMs = 120000) {
  const unknown = { state: 'unknown', remainingPercent: null, readyAt: null };
  if (!snapshot || !requiredBuckets?.length || !snapshot.accountId) return unknown;
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > maxAgeMs) return unknown;
  let remaining = 100;
  const resets = [];
  let uncertain = false;
  let blocked = snapshot.ordinaryUsageAllowed === false;
  for (const name of requiredBuckets) {
    const b = snapshot.buckets[name];
    if (!b?.windows?.length) { uncertain = true; continue; }
    if (b.spendControlReached || b.rateLimitReachedType) blocked = true;
    if ((b.spendControlReached && b.individualLimit?.remainingPercent !== 0) ||
        (b.rateLimitReachedType && b.rateLimitReachedType !== 'rate_limit_reached')) uncertain = true;
    const limits = [...b.windows, ...(b.individualLimit ? [b.individualLimit] : [])];
    for (const w of limits) {
      const r = w.remainingPercent;
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100) { uncertain = true; continue; }
      remaining = Math.min(remaining, r);
      if (r === 0) {
        blocked = true;
        const reset = Date.parse(w.resetsAt);
        if (Number.isFinite(reset) && reset > now) resets.push(reset);
        else uncertain = true; // elapsed reset still requires a fresh provider read
      }
    }
  }
  if (blocked) return { state: 'blocked', remainingPercent: 0,
    // A provider denial without an exhausted applicable window has no known reset.
    readyAt: !uncertain && resets.length ? new Date(Math.max(...resets)).toISOString() : null };
  if (uncertain || snapshot.ordinaryUsageAllowed !== true) return unknown;
  return { state: remaining <= 5 ? 'low' : 'available', remainingPercent: remaining, readyAt: null };
}

function grantFor(entry, project, model) {
  return entry?.grants.find(g => g.project === project && g.model === model);
}

export function choose({ currentId, entries, snapshots, project, model, now = Date.now(), providerLimit = false }) {
  const current = entries.find(e => e.accountId === currentId);
  const ownGrant = grantFor(current, project, model);
  const own = availability(snapshots[currentId], ownGrant?.requiredBuckets, now);
  if (providerLimit) { own.state = 'blocked'; own.remainingPercent = 0; }
  if (own.state === 'available') return { action: 'continue', current: own };
  if (own.state === 'unknown') return { action: 'observe', reason: 'unknown_current_quota', current: own };
  const targets = entries.filter(e => e.authorized && e.authRef && e.authState === 'ready' && grantFor(e, project, model))
    .map(e => ({ accountId: e.accountId,
      ...availability(snapshots[e.accountId], grantFor(e, project, model).requiredBuckets, now) }));
  const available = targets.filter(t => t.accountId !== currentId && t.state === 'available')
    .sort((a, b) => b.remainingPercent - a.remainingPercent || a.accountId.localeCompare(b.accountId));
  if (available.length) return { action: 'transition_required', target: available[0].accountId, current: own };
  if (own.state === 'low') return { action: 'continue', reason: 'no_available_alternative_continue_until_zero', current: own };
  const waiting = targets.filter(t => t.state === 'blocked' && t.readyAt)
    .sort((a, b) => Date.parse(a.readyAt) - Date.parse(b.readyAt) || a.accountId.localeCompare(b.accountId));
  if (waiting.length) return { action: 'wait', target: waiting[0].accountId,
    readyAt: waiting[0].readyAt, readyAtBangkok: bangkok(waiting[0].readyAt), current: own };
  return { action: 'gap', reason: 'no_permitted_target_with_confirmed_reset', current: own };
}
