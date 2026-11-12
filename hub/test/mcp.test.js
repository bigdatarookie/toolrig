import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
      } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['availability_request', 'availability_status']);
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
test('provider spawn failure and bounded timeout return codes, never raw provider text', async t => {
  const { dir } = fixture(t);
  await assert.rejects(new CodexReader(dir, { binary: join(dir, 'missing'), timeoutMs: 100 }).read(), /provider_unavailable/);
  const hang = join(dir, 'hang');
  writeFileSync(hang, '#!/usr/bin/env node\nsetInterval(()=>{},1000);', { mode: 0o700 });
  await assert.rejects(new CodexReader(dir, { binary: hang, timeoutMs: 100 }).read(), /provider_unavailable/);
});
