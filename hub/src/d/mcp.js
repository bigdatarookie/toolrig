import { z } from 'zod';
import { NativeQueue } from './native-queue.js';
import { taskTrace } from './task-trace.js';
import { consumeMachineEvent, recallMachineEvent, returnMachineEvent } from './machine.js';
export function registerDTools(server,queue=new NativeQueue()) {
  const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
  const expose=(name,description,inputSchema,readOnlyHint,fn)=>server.registerTool(name,{description,inputSchema,
    annotations:{readOnlyHint,destructiveHint:false}},async args=>{
    try { const result=await fn(args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,
      ...(result.outcome==='unknown'?{isError:true}:{})}; }
    catch { return {isError:true,content:[{type:'text',text:'native_task_or_event_unavailable; verify actual owner and same-operation source; do not blindly replay'}]}; }
  });
  expose('task_trace','Read bounded native task lineage/decision refs for the actual owning consumer; no transcript scan or memory deletion.',
    {qitem:id,query:z.string().max(200).optional()},true,a=>taskTrace(queue,a.qitem,{query:a.query??''}));
  expose('machine_consume','Claim/checkpoint the exact owned native machine event; does not execute its business action.',
    {qitem:id,event_id:z.string().min(1).max(128),facts:z.array(z.strictObject({value:z.string().min(1).max(1000),sourceRef:z.string().min(1).max(1000)})).max(8).optional()},false,a=>consumeMachineEvent(queue,a.qitem,{eventId:a.event_id,facts:a.facts??[]}));
  expose('machine_recall','Recall durable owned event/intent/source refs and checkpoint after context loss; no raw machine payload.',
    {qitem:id},true,a=>recallMachineEvent(queue,a.qitem));
  expose('machine_return','Native handoff of a consumed event conclusion back to its original producer; unknown effects reconcile same lineage.',
    {qitem:id,conclusion:z.string().min(1).max(1000)},false,a=>returnMachineEvent(queue,a.qitem,a.conclusion));
}
