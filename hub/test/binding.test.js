import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { OwnedAppServer } from '../src/owned-server.js';
import { bindingPlan, currentBindingPlan } from '../src/binding-plan.js';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const wsModule = createRequire(import.meta.url).resolve('ws');

function fixture(t, { alias = false } = {}) {
  const home = realpathSync(mkdtempSync('/tmp/toolrig-binding-test-'));
  const binary = join(home, 'codex-fixture');
  writeFileSync(binary, `#!/usr/bin/env node
const http=require('http');const {WebSocketServer}=require(${JSON.stringify(wsModule)}); const args=process.argv.slice(2);
{
 const path=args[args.indexOf('--listen')+1].slice('unix://'.length);
 const fs=require('fs'),crypto=require('crypto');
 const root=fs.realpathSync('/tmp')+'/codex-daemon-'+process.getuid();
 const target=${JSON.stringify(alias)} ? root+'/'+crypto.createHash('sha256').update(path).digest('hex') : path;
 if(${JSON.stringify(alias)})fs.mkdirSync(root,{recursive:true,mode:0o700});
 const server=http.createServer();new WebSocketServer({server}).on('connection',s=>{s.on('message',l=>{const m=JSON.parse(l.toString());let result;
 if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME,userAgent:'fixture/0.166.0'};
 else if(m.method==='initialized')return;
 else if(m.method==='account/read')result={account:{type:'chatgpt',planType:'pro'}};
 else if(m.method==='account/rateLimits/read')result={accountId:'fixture-a',ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:1}}};
 else throw new Error('unexpected_method');
 s.send(JSON.stringify({id:m.id,result}));});});server.listen(target,()=>{
 if(${JSON.stringify(alias)}){fs.chmodSync(target,0o600);fs.writeFileSync(target+'.lock','',{mode:0o600});fs.symlinkSync(target,path);}
 });
}`, { mode: 0o700 });
  const runtime = new OwnedAppServer(home, { binary, timeoutMs: 5000 });
  t.after(async () => { await runtime.stop(); rmSync(home, { recursive: true, force: true }); });
  return { runtime, home };
}
test('owned public Unix endpoint gives two clients the same account without claiming native-seat binding', async t => {
  const { runtime } = fixture(t); await runtime.start();
  const a = runtime.source(), b = runtime.source();
  await a.connect(); await b.connect();
  assert.equal((await a.snapshot()).usage.accountId, 'fixture-a');
  assert.equal((await b.snapshot()).usage.accountId, 'fixture-a');
  assert.equal(a.binding.nativeSeatBound, false);
  assert.equal(a.binding.kind, 'task-owned-app-server');
  await assert.rejects(a.rpc('turn/start', {}), /provider_method_not_allowed/);
  const directory = runtime.directory;
  await runtime.stop(); assert.equal(existsSync(directory), false);
});
test('no existing socket can be used before task-owned launch; changed endpoint refuses attachment', async t => {
  const { runtime } = fixture(t);
  assert.throws(() => runtime.source(), /owned_app_server_not_running/);
  await runtime.start();
  renameSync(runtime.socket, runtime.socket + '.original');
  writeFileSync(runtime.socket, 'fixture-not-a-socket');
  assert.throws(() => runtime.source(), /endpoint_custody_changed/);
});
test('Codex protected alias contract is validated and only owned physical socket/lock are cleaned', async t => {
  const { runtime } = fixture(t, { alias: true }); await runtime.start();
  assert.notEqual(runtime.physicalPath, runtime.socket);
  const physical = runtime.physicalPath;
  const client = runtime.source(); await client.connect();
  assert.equal((await client.snapshot()).usage.accountId, 'fixture-a');
  await runtime.stop();
  assert.equal(existsSync(physical), false); assert.equal(existsSync(physical + '.lock'), false);
  assert.equal(runtime.cleanupReport.ownProcessStopped, true);
});
test('startup readiness works when filesystem socket-creation notifications are absent', async t => {
  const { runtime } = fixture(t);
  runtime.watchDirectory = () => ({ once() {}, close() {} });
  await runtime.start();
  const client = runtime.source(); await client.connect();
  assert.equal((await client.snapshot()).usage.accountId, 'fixture-a');
});
test('read-only planner scopes lookup to current seat and preserves a concrete native-resume boundary', async () => {
  const calls = [];
  const result = await currentBindingPlan(async args => {
    calls.push(args);
    return args[0] === 'whoami' ? { identity: { sessionName: 'tools-hub@toolrig' } } : {
      current_occupant: 'tools-hub@toolrig', runtime: 'codex', runtime_home: { home: '/provided/home' },
      launch_cwd: '/project', permissions: { lastLaunchArguments: { daemonOptOut: true } },
    };
  });
  assert.deepEqual(calls[1], ['seat', 'status', 'tools-hub@toolrig', '--json']);
  assert.equal(result.nativeAttachmentVerified, false);
  assert.equal(result.nativeAccountId, null);
  assert.equal(result.currentMode, 'recorded_embedded_no_daemon');
  assert(result.supportedAlternative.nativeTui.includes('resume'));
  assert.equal(result.requiredImplementation.owner, 'OpenRig runtime adapter deployment');
});
test('planner refuses another occupant and does not infer embedded mode from missing metadata', () => {
  const identity = { identity: { sessionName: 'self' } };
  assert.throws(() => bindingPlan(identity, { current_occupant: 'other', runtime: 'codex' }), /seat_identity_mismatch/);
  assert.equal(bindingPlan(identity, { current_occupant: 'self', runtime: 'codex' }).currentMode, 'not_attested');
});
test('native-binding-plan does not initialize or chmod an availability metadata DB', async t => {
  const { home } = fixture(t);
  writeFileSync(join(home, 'rig'), `#!/usr/bin/env node
console.log(JSON.stringify(process.argv[2]==='whoami' ? {identity:{sessionName:'self'}} :
{current_occupant:'self',runtime:'codex',runtime_home:{home:${JSON.stringify(home)}},permissions:{lastLaunchArguments:{daemonOptOut:true}}}));
`, { mode: 0o700 });
  const db = join(home, 'should-not-be-created', 'availability.sqlite');
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'native-binding-plan'],
    { env: { ...process.env, PATH: home + ':' + process.env.PATH, CODEX_HOME: home, TOOLRIG_AVAILABILITY_DB: db } });
  assert.equal(JSON.parse(stdout).seat, 'self');
  assert.equal(existsSync(db), false);
  assert.equal(existsSync(join(home, 'should-not-be-created')), false);
});
