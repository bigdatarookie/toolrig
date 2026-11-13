import { realpathSync, statSync, readFileSync } from 'node:fs';
import { relative, isAbsolute, extname, basename } from 'node:path';
import { compactReceipt } from './receipts.js';
const notePrefix='toolrig-d/1 ';
// Explicit bounded source reading, not a new memory store or summarizer.
export function readTaskRefs(refs, roots, { byteBudget=4096 }={}) {
  if (!Array.isArray(refs) || refs.length>16 || byteBudget<0 || byteBudget>4096) throw new Error('invalid_ref_budget');
  const allowed=roots.map(root=>realpathSync(root)); const results=[]; let used=0;
  for(const ref of refs) {
    const match=/^file:(.+):L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(ref);
    if(!match) { results.push({ref,status:'locator_only; use_supported_source_tool'});continue; }
    try {
      const start=Number(match[2]),end=Number(match[3]??match[2]);
      if(end<start||end-start>=200)throw new Error('range');
      const path=realpathSync(match[1]);
      if(!allowed.some(root=>{const r=relative(root,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));}))throw new Error('scope');
      if(!['.md','.txt','.json','.yaml','.yml'].includes(extname(path))||/(^|[/.])(auth|credentials|secrets)([/.]|$)/i.test(path)||basename(path).startsWith('.env'))throw new Error('data_class');
      if(statSync(path).size>1024*1024)throw new Error('source_size');
      const lines=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)).match(/[^\n]*(?:\n|$)/g)??[];
      const wanted=lines.slice(start-1,end); let text='',count=0;
      for(const line of wanted) {if(used+Buffer.byteLength(line)>byteBudget)break;text+=line;used+=Buffer.byteLength(line);count++;}
      results.push({ref,status:count===wanted.length?'read':'partial_budget',text,lineStart:start,lineEnd:count?start+count-1:null,
        sourceUntrusted:true,rawPreserved:true});
    } catch { results.push({ref,status:'not_read; outside_scope_or_unsupported_source'}); }
  }
  return {sources:results,extractedBytes:used,budgetBytes:byteBudget,complete:results.every(r=>r.status==='read'),
    memoryPolicy:'source_selection_only; no_delete_or_history_reset',compactor:'not_invoked; bounded_extracted_bytes_below_8000_tokens'};
}
export async function taskTrace(queue,id,{query='',refs=[],roots=[]}={}) {
  if(typeof query!=='string'||query.length>200)throw new Error('invalid_query');
  const q=await queue.read(id),i=await queue.identity();
  if(q.destinationSession!==i.sessionName)throw new Error('native_task_owner_mismatch');
  const rows=await queue.journal(id);let remaining=4096;
  const decisions=[];
  for(const row of [...rows].reverse()) {
    const value=row.transitionNote;
    if(typeof value!=='string'||(!value.startsWith(notePrefix)&&(!query||!value.includes(query))))continue;
    const bytes=Buffer.byteLength(value);if(bytes>remaining)continue;remaining-=bytes;
    decisions.push({value,actor:row.actorSession??null,observedAt:row.ts??null,
      source:{qitemId:id,transitionId:row.transitionId}});
    if(decisions.length>=8)break;
  }
  return {...compactReceipt(id,q),intent:{summary:q.summary??null,bodyRef:{command:['rig','queue','show',id,'--full','--json']}},
    lineage:{parent:q.handedOffFrom??null,root:q.chainOfRecord?.[0]??null,tail:(q.chainOfRecord??[]).slice(-4),count:q.chainOfRecord?.length??0,coverage:'native_refs_only; full_chain_remains_in_native_record'},decisions,
    evidence:readTaskRefs(refs,roots,{byteBudget:remaining}),nextAction:'not_inferred; see_native_obligation_and_source_refs',
    completeHistory:false,earnedMemoryReset:false};
}
