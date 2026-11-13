import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CodexReader } from '../src/codex.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'toolrig-mcp-'));
  const binary = join(dir, 'codex');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(binary, `#!/usr/bin/env node
const rl = require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m=JSON.parse(line); let result;
 if(m.method==='initialize') result={codexHome:process.env.CODEX_HOME,userAgent:'fixture/0.166.0'};
 else if(m.method==='initialized')return;
 else if(m.method==='account/read')result={account:{type:'chatgpt',email:'private@example.invalid',planType:'pro'}};
 else if(m.method==='account/rateLimits/read') {
   console.log(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{primary:null}}}));
   result={accountId:'fixture-a',ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:95,resetsAt:1795089724}}};
 } else { console.log(JSON.stringify({id:m.id,error:{message:'disallowed_rpc'}}));return; }
 console.log(JSON.stringify({id:m.id,result}));
});
`, { mode: 0o700 });
  return { dir, binary };
}
test('SDK MCP discovery and call share same service; caller cannot supply home/identity', async t => {
  const { dir } = fixture(t);
  const client = new Client({ name: 'test-consumer', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], env: {
        ...process.env, PATH: dir + ':' + process.env.PATH, CODEX_HOME: dir,
        TOOLRIG_AVAILABILITY_DB: join(dir, 'state.sqlite'), OPENRIG_SESSION_NAME: 'consumer@toolrig',
        TOOLRIG_DOCUMENTS_CLI: '', TOOLRIG_DOCUMENTS_ROOT: '',
        TOOLRIG_GITHUB_API_URL: 'https://api.github.com', TOOLRIG_CI_CACHE_DIR: join(dir, 'ci-cache'), GH_TOKEN: '', GITHUB_TOKEN: '',
      } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['availability_request', 'availability_status', 'ci_digest', 'state_snapshot']);
    const response = await client.callTool({ name: 'availability_status', arguments: {} });
    assert.equal(response.structuredContent.buckets.codex.windows[0].remainingPercent, 5);
    assert.equal(response.structuredContent.consumer, 'consumer@toolrig');
    assert.equal(response.structuredContent.home, dir);
    assert.doesNotMatch(JSON.stringify(response), /private@example/);
    const denied = await client.callTool({ name: 'availability_request', arguments: { continuation: {
      seat: 'imposter', qitem: 'q', conversationId: 'c', cwd: dir, configRef: 'c', permissions: 'yolo',
      model: 'other', effort: 'high', affectedCohort: ['imposter'],
    } } });
    assert.equal(denied.isError, true);
  } finally { await client.close(); }
});
test('Hub MCP consumer can call the read-only CI digest against a local GitHub REST fixture', async t => {
  const { dir } = fixture(t);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/repos/owner/project/actions/runs/100') {
      response.end(JSON.stringify({ id: 100, run_attempt: 1, status: 'completed', conclusion: 'failure',
        head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', head_branch: 'topic', event: 'pull_request',
        html_url: 'https://github.com/owner/project/actions/runs/100', created_at: '2026-11-12T12:00:00Z',
        updated_at: '2026-11-12T12:01:00Z', pull_requests: [] }));
    } else if (url.pathname === '/repos/owner/project/actions/runs/100/attempts/1/jobs') {
      response.end(JSON.stringify({ total_count: 1, jobs: [{ id: 202, name: 'macos tests', status: 'completed',
        conclusion: 'failure', completed_at: '2026-11-12T12:01:00Z', html_url: 'https://github.com/owner/project/actions/runs/100/job/202',
        check_run_url: 'https://api.github.com/repos/owner/project/check-runs/202',
        steps: [{ name: 'Run tests', number: 2, status: 'completed', conclusion: 'failure' }] }] }));
    } else if (url.pathname === '/repos/owner/project/check-runs/202/annotations') {
      response.end(JSON.stringify([{ annotation_level: 'failure', message: 'Process completed with exit code 1.',
        path: '.github/workflows/test.yml', start_line: 12, end_line: 12 }]));
    } else if (url.pathname === '/repos/owner/project/actions/jobs/202/logs') {
      response.statusCode = 403;
      response.end(JSON.stringify({ message: 'Must have admin rights to Repository.' }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Not Found' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'ci-digest-consumer', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], env: {
        ...process.env, PATH: dir + ':' + process.env.PATH, CODEX_HOME: dir,
        TOOLRIG_AVAILABILITY_DB: join(dir, 'state.sqlite'), OPENRIG_SESSION_NAME: 'ci-consumer@toolrig',
        TOOLRIG_DOCUMENTS_CLI: '', TOOLRIG_DOCUMENTS_ROOT: '', TOOLRIG_GITHUB_API_URL: apiUrl,
        TOOLRIG_CI_CACHE_DIR: join(dir, 'ci-cache'), GH_TOKEN: '', GITHUB_TOKEN: '',
      } }));
    const result = await client.callTool({ name: 'ci_digest', arguments: { repository: 'owner/project', run_id: 100, attempt: 1 } });
    assert.equal(result.structuredContent.status, 'failure');
    assert.equal(result.structuredContent.jobs[0].failedSteps[0].name, 'Run tests');
    assert.equal(result.structuredContent.jobs[0].logStatus, 'permission_denied');
    assert.equal(result.structuredContent.jobs[0].findings[0].message, 'Process completed with exit code 1.');
  } finally { await client.close(); }
});
test('configured document tools route extraction over MCP and enforce root', async t => {
  const { dir } = fixture(t);
  const documentsRoot = join(dir, 'documents');
  mkdirSync(documentsRoot);
  const document = join(documentsRoot, 'table.pdf');
  writeFileSync(document, 'fixture');
  const outside = join(dir, 'outside.pdf');
  writeFileSync(outside, 'outside');
  const documentsCli = join(dir, 'toolrig-documents');
  writeFileSync(documentsCli, `#!/usr/bin/env node
const [command, path, ...options] = process.argv.slice(2);
const operation = command === 'extract-tables' ? 'extract_tables' : command;
process.stdout.write(JSON.stringify({ok:true,status:'ok',operation,source:{name:path.split('/').pop(),format:'pdf'},data:{tables:[{page:1,table:1,rows:[['Item','Units'],['apples','12'],['pears','7']]}]},source_refs:[{page:1,table:1}],warnings:[],options,artifactDir:process.env.TOOLRIG_DOCUMENT_ARTIFACT_DIR}));
`, { mode: 0o700 });
  const client = new Client({ name: 'documents-consumer', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], env: {
        ...process.env, PATH: dir + ':' + process.env.PATH, CODEX_HOME: dir,
        TOOLRIG_AVAILABILITY_DB: join(dir, 'state.sqlite'), OPENRIG_SESSION_NAME: 'documents-consumer@toolrig',
        TOOLRIG_DOCUMENTS_CLI: documentsCli,
        TOOLRIG_DOCUMENTS_ROOT: documentsRoot,
        TOOLRIG_DOCUMENT_ARTIFACT_DIR: join(dir, 'artifacts'),
      } }));
    const tools = await client.listTools();
    for (const name of ['documents_inspect', 'documents_read', 'documents_render', 'documents_extract_tables']) {
      assert.ok(tools.tools.some(tool => tool.name === name), `missing ${name}`);
    }
    const extracted = await client.callTool({ name: 'documents_extract_tables', arguments: { path: document, pages: '1' } });
    assert.equal(extracted.structuredContent.ok, true);
    assert.equal(extracted.structuredContent.operation, 'extract_tables');
    assert.deepEqual(extracted.structuredContent.options, ['--pages', '1']);
    assert.equal(extracted.structuredContent.artifactDir, join(dir, 'artifacts'));
    assert.deepEqual(extracted.structuredContent.source_refs, [{ page: 1, table: 1 }]);
    assert.deepEqual(extracted.structuredContent.data.tables[0].rows, [['Item', 'Units'], ['apples', '12'], ['pears', '7']]);

    const rejected = await client.callTool({ name: 'documents_read', arguments: { path: outside } });
    assert.equal(rejected.structuredContent.ok, false);
    assert.equal(rejected.structuredContent.error.code, 'path_outside_configured_root');
  } finally { await client.close(); }
});
test('provider spawn failure and bounded timeout return codes, never raw provider text', async t => {
  const { dir } = fixture(t);
  await assert.rejects(new CodexReader(dir, { binary: join(dir, 'missing'), timeoutMs: 100 }).read(), /provider_unavailable/);
  const hang = join(dir, 'hang');
  writeFileSync(hang, '#!/usr/bin/env node\nsetInterval(()=>{},1000);', { mode: 0o700 });
  await assert.rejects(new CodexReader(dir, { binary: hang, timeoutMs: 100 }).read(), /provider_unavailable/);
});

test('state SDK tool shares deterministic projection and does not initialize availability metadata', async t => {
  const { dir } = fixture(t), db = join(dir, 'must-stay-absent', 'availability.sqlite');
  writeFileSync(join(dir, 'rig'), `#!/usr/bin/env node
const a=process.argv.slice(2);let r;
if(a[0]==='whoami')r={identity:{rigName:'fixture',sessionName:'owner@fixture'}};
else if(a[0]==='--version'){console.log('0.7.7 (fixture)');process.exit(0);}
else if(a[0]==='ps')r={entries:[],totalNodes:0,truncated:false};
else if(a[0]==='queue')r=[];
else process.exit(1);
console.log(JSON.stringify(r));`, { mode: 0o700 });
  const client = new Client({ name: 'state-consumer', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], env: {
        ...process.env, PATH: dir + ':' + process.env.PATH, TOOLRIG_STATE_CACHE_DIR: join(dir, 'state-cache'), CODEX_HOME: dir,
        TOOLRIG_AVAILABILITY_DB: db, TOOLRIG_DOCUMENTS_CLI: '', TOOLRIG_DOCUMENTS_ROOT: '',
      } }));
    const first = await client.callTool({ name: 'state_snapshot', arguments: {
      rig: 'fixture', project: 'fixture', filter: { states: 'active' } } });
    assert.equal(first.structuredContent.status, 'ok');
    const second = await client.callTool({ name: 'state_snapshot', arguments: {
      rig: 'fixture', project: 'fixture', filter: { states: 'active' }, cursor: first.structuredContent.cursor } });
    assert.equal(second.structuredContent.changed, false); assert.notEqual(second.isError, true);
    assert.deepEqual(Object.keys(second.structuredContent).sort(), ['changed', 'coverage', 'cursor', 'observedAt']);
    assert.equal(existsSync(db), false);
  } finally { await client.close(); }
});
