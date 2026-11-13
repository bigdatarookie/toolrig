import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const idPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const checkId = id => { if (!idPattern.test(id)) throw new Error('invalid_native_id'); return id; };
export async function nativeJson(args) {
  let stdout;
  try { stdout=(await exec('rig',args,{timeout:15000,maxBuffer:2*1024*1024})).stdout; }
  catch(error) { stdout=error.stdout; }
  let result;
  try { result=JSON.parse(stdout); } catch { throw new Error('native_operation_unavailable_or_unknown'); }
  if(result?.error) {
    if(args[0]==='queue'&&args[1]==='show'&&result.error==='qitem_not_found') {
      throw Object.assign(new Error('native_record_not_found'),{code:'native_not_found'});
    }
    throw new Error('native_operation_unavailable_or_unknown');
  }
  return result;
}
// Each adapter runs under its actual inherited actor. Runtime composition may
// instead implement this interface through native QueueRepository capabilities.
// No API accepts an env override, private database, provider history or shell.
export class NativeQueue {
  constructor({ run = nativeJson } = {}) { this.run = run; }
  async identity() {
    const i = (await this.run(['whoami','--json'])).identity;
    if (!i?.sessionName || !i.nodeId) throw new Error('native_actor_unavailable');
    return i;
  }
  async read(id) {
    const q = await this.run(['queue','show',checkId(id),'--full','--json']);
    if (q.qitemId !== id || !q.destinationSession || !q.state) throw new Error('native_record_invalid');
    return q;
  }
  async find(id) {
    try { return await this.read(id); } catch(error) { if(error.code==='native_not_found')return null;throw error; }
  }
  async journal(id) {
    const rows = await this.run(['queue','transitions',checkId(id),'--full','--json']);
    if (!Array.isArray(rows)) throw new Error('native_journal_invalid');
    return rows;
  }
  async bodyCommand(args, body) {
    const directory = mkdtempSync(join(tmpdir(), 'toolrig-d-'));
    const file = join(directory,'body.json');
    try {
      writeFileSync(file, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
      return await this.run([...args,'--body-file',file,'--full','--json']);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
  create(id, owner, body) {
    return this.bodyCommand(['queue','create','--id',checkId(id),'--destination',owner,
      '--summary','Machine event obligation '+body.eventId,'--tags','project:'+body.project+',machine:d-v1'], body);
  }
  claim(id) { return this.run(['queue','claim',checkId(id),'--json']); }
  note(id, marker) { return this.run(['queue','update',checkId(id),'--note','toolrig-d/1 '+JSON.stringify(marker),'--json']); }
  async handoff(id, owner, body, { nudge = true } = {}) {
    const result = await this.bodyCommand(['queue','handoff-and-complete',checkId(id),'--to',owner,
      '--summary','Machine continuation '+body.eventId,'--tags','project:'+body.project+',machine:d-v1',...(nudge ? [] : ['--no-nudge'])], body);
    if (result.closed?.qitemId !== id || !result.created?.qitemId || result.created.destinationSession !== owner) throw new Error('native_handoff_unknown');
    return result.created;
  }
  complete(id,resolution) { return this.run(['queue','update',checkId(id),'--state','done','--closure-reason','no-follow-on','--resolution',resolution,'--json']); }
  async children(id, owner) {
    const rows = await this.run(['queue','list','--destination',owner,'--all','--limit','1000','--json']);
    if (!Array.isArray(rows) || rows.length >= 1000) throw new Error('native_lineage_coverage_unknown');
    return rows.filter(q => q.handedOffFrom === id);
  }
}
