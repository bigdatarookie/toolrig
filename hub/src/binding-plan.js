import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bangkok } from './policy.js';
const exec = promisify(execFile);
const read = async args => JSON.parse((await exec('rig', args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout);

export function bindingPlan(identity, status) {
  const seat = identity?.identity?.sessionName;
  if (!seat || status.current_occupant !== seat || status.runtime !== 'codex') throw new Error('seat_identity_mismatch');
  const embedded = status.permissions?.lastLaunchArguments?.daemonOptOut === true;
  return {
    seat, nativeAccountId: null, nativeAttachmentVerified: false,
    currentMode: embedded ? 'recorded_embedded_no_daemon' : 'not_attested',
    currentAttachment: embedded ? 'no_remote_transport_for_embedded_session' : 'requires_native_owner_observation',
    home: status.runtime_home?.home ?? null, cwd: status.launch_cwd ?? null,
    supportedAlternative: {
      transport: 'dedicated_per_seat_public_unix_app_server',
      nativeTui: ['codex', '--remote', 'unix://<seat-owned-control-socket>', 'resume', '<same-native-conversation-id>'],
      eventDelivery: 'owning thread connection or explicit owner relay; second read client is not a thread subscriber',
      accountRead: 'same owning app-server AuthManager; account/rateLimits/read supplies backend accountId',
      attachmentAuthority: 'runtime owner creates endpoint and binds PID/socket/thread/generation to existing seat',
    },
    requiredImplementation: {
      owner: 'OpenRig runtime adapter deployment',
      sourceSeam: 'CodexRuntimeAdapter.prepareLaunch/seatCommand + native attachment read model',
      change: 'opt-in dedicated server lifecycle, native TUI --remote, thread event relay, authenticated binding receipt',
      continuity: 'supported native resume only after original conversation/config/model/effort/permissions are verified',
      notAuthorizedByThisPlan: ['patch running daemon', 'restart current seat/neighbors', 'shared home auth switch'],
    },
    nextAction: 'review prepared endpoint adapter/canary; implement owner-side opt-in launch in an isolated OpenRig source candidate, before any live seat migration',
  };
}
export async function currentBindingPlan(run = read) {
  const identity = await run(['whoami', '--json']);
  const seat = identity?.identity?.sessionName;
  if (!seat) throw new Error('native_identity_unavailable');
  const status = await run(['seat', 'status', seat, '--json']);
  const observedAt = new Date().toISOString();
  return { ...bindingPlan(identity, status), source: 'openrig:whoami+seat/status', observedAt,
    observedAtBangkok: bangkok(observedAt),
    recordedLaunchObservedAt: status.permissions?.lastLaunchArguments?.observedAt ?? null };
}
