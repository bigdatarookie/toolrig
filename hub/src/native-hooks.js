import { fileURLToPath } from 'node:url';
import { launchSpec, backendOverrides } from './native-plan.js';

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

// Build-time integration dependency for CodexRuntimeAdapter. Disabled by default;
// no installed class is patched, and prepare/print-plan never starts a runtime.
export class NativeLaunchHooks {
  constructor({ enabledFor = () => false, captureOriginal, runtimeRoot, resolveCodexEntry,
    entrypoint = fileURLToPath(new URL('./native-launch-main.js', import.meta.url)) } = {}) {
    Object.assign(this, { enabledFor, captureOriginal, runtimeRoot, resolveCodexEntry, entrypoint });
    this.commands = new Map();
  }
  async prepareLaunch(binding, name, prepared, opts) {
    if (!this.enabledFor(binding.nodeId)) return prepared;
    if (!prepared.ok || opts?.installCorePlugin !== false) throw new Error('native_opt_in_requires_resume');
    const prior = await this.captureOriginal(binding, prepared);
    // captureOriginal is the native owner's internal observation boundary, not
    // a caller-supplied JSON flag or credential/profile-name attestation.
    const spec = launchSpec.parse({ ...prior, version: 1, enabled: true, seat: name,
      nodeId: binding.nodeId, generation: binding.launchGeneration, runtimeRoot: this.runtimeRoot,
      codexEntry: await this.resolveCodexEntry(binding) });
    if (spec.cwd !== binding.cwd || spec.model !== prepared.model || spec.effort !== prepared.effort ||
        spec.configProfile !== (prepared.profile ?? null)) throw new Error('native_prepared_settings_drift');
    backendOverrides(spec); // reject unrepresented/unsafe CLI config before staging
    return { ...prepared, nativeLaunchSpec: spec };
  }
  resumeCore(prepared, threadId) {
    const spec = prepared.nativeLaunchSpec;
    if (!spec || threadId !== spec.threadId) throw new Error('native_resume_identity_drift');
    const payload = Buffer.from(JSON.stringify(spec)).toString('base64url');
    const command = `env CODEX_HOME=${quote(spec.home)} ${quote(process.execPath)} ${quote(this.entrypoint)} ${quote(payload)}`;
    this.commands.set(command, spec);
    return command;
  }
  async seatCommand(binding, command, seatLaunchEnvironment) {
    const spec = this.commands.get(command);
    if (!spec) return undefined; // caller uses its unchanged legacy path
    this.commands.delete(command);
    if (binding.nodeId !== spec.nodeId || binding.launchGeneration !== spec.generation || binding.cwd !== spec.cwd) {
      throw new Error('native_command_generation_drift');
    }
    // Deliberately omit codexCwd: the existing writer only accepts `codex ...`
    // for that rewrite. The plan already holds the resolved absolute Codex entry;
    // cwd/home are explicit and provider credentials stay inherited in the pane.
    // Its existing identity/PATH/generation wrapper still encloses the supervisor,
    // backend and native TUI exactly once. No daemon-context backend spawn.
    return seatLaunchEnvironment.command(binding.tmuxSession, command, {
      nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: 'codex',
      ...(binding.accountHome !== undefined ? { accountHome: binding.accountHome } : {}),
    });
  }
}
