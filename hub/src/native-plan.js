import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = z.string().min(1);
const path = text.refine(isAbsolute);
export const launchSpec = z.strictObject({
  version: z.literal(1), enabled: z.literal(true), seat: text, nodeId: text, generation: text,
  threadId: text, qitem: text, project: text, cwd: path, home: path,
  model: text, effort: text, modelProvider: text, accountId: text,
  approvalPolicy: z.unknown(), approvalsReviewer: text, serviceTier: text.nullable(), sandbox: z.unknown(), sandboxMode: z.enum(['danger-full-access', 'read-only', 'workspace-write']),
  permissionsRef: text, configRef: text, affectedCohort: z.array(text).min(1),
  runtimeWorkspaceRoots: z.array(path), activePermissionProfile: z.unknown(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configOverrides: z.record(z.string(), z.unknown()), configProfile: z.null(),
  runtimeRoot: path, codexEntry: z.strictObject({ file: path, prefix: z.array(z.string()) }),
});
const extraKeys = new Set(['sandbox_workspace_write.writable_roots', 'sandbox_workspace_write.network_access',
  'sandbox_workspace_write.exclude_tmpdir_env_var', 'sandbox_workspace_write.exclude_slash_tmp']);
export function backendOverrides(spec) {
  const base = { model: spec.model, model_reasoning_effort: spec.effort, model_provider: spec.modelProvider,
    approval_policy: spec.approvalPolicy, sandbox_mode: spec.sandboxMode };
  for (const [key, value] of Object.entries(spec.configOverrides)) {
    if (!extraKeys.has(key)) throw new Error('unsupported_native_config_override');
    if (!(typeof value === 'boolean' || (Array.isArray(value) && value.every(v => typeof v === 'string')))) {
      throw new Error('unsupported_native_config_value');
    }
    base[key] = value;
  }
  // Metadata settings only. Credentials/environment are never serialized here.
  return Object.entries(base).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}

export function validateLaunchEnvironment(spec, env, cwd) {
  if (env.OPENRIG_NODE_ID !== spec.nodeId || env.OPENRIG_SESSION_NAME !== spec.seat ||
      env.OPENRIG_OCCUPANT_GENERATION !== spec.generation || env.OPENRIG_RUNTIME !== 'codex' ||
      env.CODEX_HOME !== spec.home || cwd !== spec.cwd) throw new Error('native_launch_environment_drift');
}

// One runtime-generation lease, not a task tracker. Never clears an unknown
// existing lease or retries a previous launch with unknown effects.
export class GenerationLease {
  constructor(spec) {
    this.spec = spec;
    this.root = join(spec.runtimeRoot, createHash('sha256').update(spec.nodeId).digest('hex'));
    this.path = join(this.root, 'active.json');
    this.value = { nodeId: spec.nodeId, seat: spec.seat, generation: spec.generation,
      ownerId: randomUUID(), supervisorPid: process.pid };
  }
  claim() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() ||
        (directory.mode & 0o077) !== 0) throw new Error('unsafe_native_lease_directory');
    const fd = openSync(this.path, 'wx', 0o600);
    try { writeFileSync(fd, canonical(this.value)); } finally { closeSync(fd); }
    this.identity = lstatSync(this.path);
    return this;
  }
  current() {
    if (!this.identity) return false;
    try {
      const s = lstatSync(this.path);
      return s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0 &&
        s.dev === this.identity.dev && s.ino === this.identity.ino && canonical(JSON.parse(readFileSync(this.path, 'utf8'))) === canonical(this.value);
    } catch { return false; }
  }
  release() { if (this.current()) unlinkSync(this.path); this.identity = null; }
}
