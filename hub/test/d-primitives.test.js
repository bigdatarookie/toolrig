import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MachineDelivery, enqueueMachineEvent, consumeMachineEvent, recallMachineEvent, returnMachineEvent, digest, deliveryId } from '../src/d/machine.js';
import { NativeQueue } from '../src/d/native-queue.js';
import { compactReceipt, writeThenReconcile } from '../src/d/receipts.js';
import { readTaskRefs, taskTrace } from '../src/d/task-trace.js';
const copy=v=>JSON.parse(JSON.stringify(v));
const binding={seat:'worker@fixture',nodeId:'worker-node',generation:'generation-1',threadId:'original-native-thread'};
const raw='units=USD\nvalue=UNKNOWN\ncompany NAME:  kept  whitespace\n';
const event={eventId:'event-1',project:'fixture',producer:'producer@fixture',owner:binding.seat,sourceTask:'qitem-parent',
 intentRef:'native:qitem-parent#body',nextAction:{value:'Inspect the sourced result and return its exact limitation.',sourceRef:'native:qitem-parent#body'},
 sourceRefs:['fixture:issuer','native:qitem-parent#body'],payloadRef:'fixture:payload',payloadDigest:digest(raw)};
class Store {
 constructor(){this.rows=new Map();this.logs=new Map();this.calls=[];this.next=0;this.rows.set(event.sourceTask,{qitemId:event.sourceTask,destinationSession:event.producer,state:'in-progress',tags:['project:fixture'],body:'Human mission and earned memory remain here.'});}
 queue(seat){const s=this;return {
  identity:async()=>({sessionName:seat,nodeId:seat===binding.seat?binding.nodeId:'producer-node'}),
  find:async id=>s.rows.has(id)?copy(s.rows.get(id)):null,
  read:async id=>{s.calls.push(['read',id]);if(!s.rows.has(id))throw new Error('missing');return copy(s.rows.get(id));},
  journal:async id=>copy(s.logs.get(id)??[]),
  create:async(id,owner,body)=>{s.calls.push(['create',id]);if(s.rows.has(id))throw new Error('existing');s.rows.set(id,{qitemId:id,destinationSession:owner,sourceSession:seat,state:'pending',tags:['project:'+body.project,'machine:d-v1'],body:JSON.stringify(body)});return copy(s.rows.get(id));},
  claim:async id=>{s.calls.push(['claim',id]);const q=s.rows.get(id);if(q.destinationSession!==seat||q.state!=='pending')throw new Error('not_claimable');q.state='in-progress';return copy(q);},
  note:async(id,m)=>{s.calls.push(['note',id,m.phase]);const rows=s.logs.get(id)??[];rows.push({transitionId:++s.next,qitemId:id,actorSession:seat,transitionNote:'toolrig-d/1 '+JSON.stringify(m),ts:'2026-11-14T00:00:00Z'});s.logs.set(id,rows);return copy(s.rows.get(id));},
  handoff:async(id,owner,body,opts={})=>{s.calls.push(['handoff',id,opts]);const q=s.rows.get(id);if(q.destinationSession!==seat||q.state!=='in-progress')throw new Error('terminal_or_owner');q.state='done';q.handedOffTo=owner;const child='qitem-child-'+(++s.next);const c={qitemId:child,destinationSession:owner,sourceSession:seat,state:'pending',handedOffFrom:id,tags:['project:'+body.project,'machine:d-v1'],body:JSON.stringify(body)};s.rows.set(child,c);return copy(c);},
  complete:async(id,resolution)=>{const q=s.rows.get(id);if(q.destinationSession!==seat||q.state!=='in-progress')throw new Error('not_owned');q.state='done';q.closureReason='no-follow-on';q.resolution=resolution;return copy(q);},
  children:async(id,owner)=>[...s.rows.values()].filter(q=>q.handedOffFrom===id&&q.destinationSession===owner).map(copy),
 };}
}
function channel(overrides={},base=binding) {
 const receipts=new Map();const c={calls:[],assertCurrent:async()=>copy(base),
  send:async request=>{c.calls.push(copy(request));const r={status:'accepted',transport:'toolOutput',retain:false,binding:copy(base),requestId:'rpc-1',turnId:'turn-1'};receipts.set(request.operationId,r);return r;},
  reconcile:async req=>receipts.get(req.operationId)??{status:'unknown'},...overrides};return c;
}
async function setup(extra={}) {
 const store=new Store(),producer=store.queue(event.producer),worker=store.queue(binding.seat);
 const queued=await enqueueMachineEvent(producer,{...event,...extra});
 const native=channel(); const delivery=new MachineDelivery({queue:worker,channel:native,payloadReader:async()=>raw});
 return {store,producer,worker,id:queued.qitemId,native,delivery};
}
test('synthetic E2E: typed wake -> native consume -> local memory loss -> recall -> native return, no replay',async()=>{
 const f=await setup();const delivered=await f.delivery.deliver(f.id);assert.equal(delivered.outcome,'wake_accepted');
 const request=f.native.calls[0];assert.equal(request.toolOutput.retain,false);assert.equal(request.toolOutput.name,'openrig_events');
 const supplied=JSON.parse(request.toolOutput.output);assert.equal(supplied.raw,raw);assert.equal(supplied.intentRef,event.intentRef);
 const work=delivered.qitemId;const consumed=await consumeMachineEvent(f.worker,work,{eventId:event.eventId,facts:[{value:'value=UNKNOWN;units=USD',sourceRef:'fixture:issuer'}]});
 assert.equal(consumed.outcome,'consumed');
 // Synthetic compaction is only loss of local transport/model objects. Native
 // queue/body/journal persist; this is NOT real provider compaction proof.
 f.delivery=null;f.native=null;
 const recalled=await recallMachineEvent(f.store.queue(binding.seat),work);
 assert.equal(recalled.eventId,event.eventId);assert.equal(recalled.intentRef,event.intentRef);assert.equal(recalled.consumed,true);
 assert.equal(recalled.facts[0].value,'value=UNKNOWN;units=USD');assert.equal(recalled.rawPayloadRetained,false);
 assert(!JSON.stringify([...f.store.rows.values()]).includes('kept  whitespace'));
 const returned=await returnMachineEvent(f.worker,work,'UNKNOWN retained; continue original parent from source refs.');
 assert.equal(returned.outcome,'returned_native');assert.equal(returned.owner,event.producer);
 assert(returned.nativeReturnTransport.includes('requires_runtime_receipt'));
 const count=f.store.rows.size;const again=await returnMachineEvent(f.worker,work,'UNKNOWN retained; continue original parent from source refs.');
 assert.equal(again.qitemId,returned.qitemId);assert.equal(f.store.rows.size,count);
 const newAdapter=new MachineDelivery({queue:f.worker});assert.equal((await newAdapter.deliver(f.id)).outcome,'consumed');
 assert.equal((await f.producer.read(event.sourceTask)).body,'Human mission and earned memory remain here.');
});
test('native CAS allows one concurrent launch and no duplicate consumer obligation',async()=>{
 const f=await setup();const results=await Promise.all(Array.from({length:12},()=>f.delivery.deliver(f.id)));
 assert.equal(f.native.calls.length,1);assert.equal((await f.worker.children(f.id,event.owner)).length,1);
 assert.equal(results.filter(r=>r.outcome==='wake_accepted').length>=1,true);
});
test('lost RPC response reconciles same operation without another model turn',async()=>{
 const f=await setup();const send=f.native.send;f.native.send=async req=>{await send(req);throw new Error('response_lost');};
 assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');
 const r=await f.delivery.deliver(f.id);assert.equal(r.outcome,'wake_accepted_runtime_receipt');assert.equal(f.native.calls.length,1);
});
test('lost runtime receipt or handoff response is UNKNOWN, never a second delivery',async()=>{
 const f=await setup();f.native.send=async req=>{f.native.calls.push(req);throw new Error('unknown');};
 await f.delivery.deliver(f.id);assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');assert.equal(f.native.calls.length,1);
 const g=await setup();const handoff=g.worker.handoff;g.worker.handoff=async(...args)=>{await handoff(...args);throw new Error('lost');};
 assert.equal((await g.delivery.deliver(g.id)).outcome,'unknown');assert.equal((await g.delivery.deliver(g.id)).outcome,'unknown');
 assert.equal(g.native.calls.length,0);assert.equal((await g.worker.children(g.id,event.owner)).length,1);
});
test('no channel/JSON flag is not machine delivery; native obligation remains pending',async()=>{
 const f=await setup();f.delivery.channel={verified:true};const r=await f.delivery.deliver(f.id);
 assert.equal(r.machineTransport,'NOT_IMPLEMENTED');assert.equal((await f.worker.read(f.id)).state,'pending');
 assert.equal(f.native.calls.length,0);
});
test('owner, node, source task, payload digest, settings drift and human kind fail closed',async()=>{
 const f=await setup();await assert.rejects(enqueueMachineEvent(f.producer,{...event,kind:'human_decision'}),/not_machine/);
 await assert.rejects(enqueueMachineEvent(f.worker,event),/producer_task_owner/);
 const wrong=new MachineDelivery({queue:f.producer,channel:f.native,payloadReader:async()=>raw});await assert.rejects(wrong.deliver(f.id),/owner_mismatch/);
 f.delivery.payloadReader=async()=>raw+' altered';await assert.rejects(f.delivery.deliver(f.id),/digest/);assert.equal(f.native.calls.length,0);
 f.delivery.payloadReader=async()=>raw;let n=0;f.native.assertCurrent=async()=>({...binding,generation:++n===1?'generation-1':'generation-2'});
 assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');assert.equal(f.native.calls.length,0);
});
test('incorrect receipt cannot count machine acceptance and never silently resends',async()=>{
 const f=await setup();f.native.send=async req=>{f.native.calls.push(req);return {status:'accepted',transport:'user_message',retain:false};};
 assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');assert.equal(f.native.calls.length,1);
 assert.equal((await f.delivery.reconcile(f.id)).outcome,'unknown');assert.equal(f.native.calls.length,1);
});
test('consume mismatch, unsupported fact source, duplicate consume and pre-consume return are guarded',async()=>{
 const f=await setup(),work=(await f.delivery.deliver(f.id)).qitemId;
 await assert.rejects(consumeMachineEvent(f.worker,work,{eventId:'other'}),/mismatch/);
 await assert.rejects(consumeMachineEvent(f.worker,work,{eventId:event.eventId,facts:[{value:'x',sourceRef:'foreign'}]}),/fact_source/);
 await assert.rejects(returnMachineEvent(f.worker,work,'premature'),/checkpoint/);
 const a=await consumeMachineEvent(f.worker,work,{eventId:event.eventId});const n=f.store.logs.get(work).length;
 const b=await consumeMachineEvent(f.worker,work,{eventId:event.eventId});assert.equal(a.outcome,'consumed');assert.equal(b.outcome,'already_consumed');assert.equal(f.store.logs.get(work).length,n);
});
test('same ID conflict is not silently rebound, unknown create reconciles existing native PK',async()=>{
 const f=await setup();const size=f.store.rows.size;
 const writes=f.store.calls.filter(c=>c[0]==='create').length;
 const same=await enqueueMachineEvent(f.producer,event);assert.equal(same.qitemId,f.id);assert.equal(f.store.rows.size,size);
 assert.equal(f.store.calls.filter(c=>c[0]==='create').length,writes);
 await assert.rejects(enqueueMachineEvent(f.producer,{...event,payloadDigest:digest('different')}),/conflict/);
 assert.equal(deliveryId({...event}),f.id);
});
test('receipts preserve compact native changes and unknown mutation executes no retry',async()=>{
 const q={qitemId:'q',destinationSession:'worker',state:'done'};
 const r=compactReceipt('op',q,{before:{state:'in-progress',destinationSession:'worker'}});
 assert.equal(r.changed.state.to,'done');assert.equal(r.source.command[3],'q');
 let writes=0,reads=0;
 const receipt=await writeThenReconcile('op',async()=>{writes++;throw new Error('lost');},async()=>{reads++;return {operationId:'op',outcome:'reconciled'};});
 assert.equal(receipt.outcome,'reconciled');assert.equal(writes,1);assert.equal(reads,1);
});
test('native CLI adapter uses addressed JSON verbs and real body-file cleanup, no identity override',async()=>{
 let file;const seen=[];
 const q=new NativeQueue({run:async args=>{seen.push(args);if(args[0]==='whoami')return {identity:{sessionName:binding.seat,nodeId:binding.nodeId}};
  if(args.includes('--body-file')){assert(args.includes('--full'));file=args[args.indexOf('--body-file')+1];assert(existsSync(file));assert.equal(JSON.parse(readFileSync(file)).eventId,event.eventId);return {qitemId:'q'};}
  return [];}});
 await q.identity();await q.create('qitem-event',binding.seat,event);assert.equal(existsSync(file),false);
 assert(seen.every(a=>!a.includes('--sender')&&!a.includes('--actor')));
});
test('task refs preserve exact raw fields, block outside roots and bound output without history reset',async t=>{
 const root=mkdtempSync(join(tmpdir(),'toolrig-d-ref-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'evidence.md');writeFileSync(path,raw);
 const out=readTaskRefs(['file:'+path+':L1-L3','file:/etc/passwd:L1'],[root]);
 assert.equal(out.sources[0].text,raw);assert.equal(out.sources[0].rawPreserved,true);assert(out.sources[1].status.startsWith('not_read'));
 writeFileSync(path,'9'.repeat(5000)+' USD\n');const big=readTaskRefs(['file:'+path+':L1'],[root]);assert.equal(big.sources[0].status,'partial_budget');assert.equal(big.sources[0].text,'');
 const f=await setup();const trace=await taskTrace(f.producer,event.sourceTask);assert.equal(trace.earnedMemoryReset,false);assert.equal(trace.intent.bodyRef.command[3],event.sourceTask);
 await assert.rejects(taskTrace(f.worker,event.sourceTask),/owner_mismatch/);
});
test('stop/block at the pending work boundary prevents machine wake and preserves obligation',async()=>{
 const f=await setup();const note=f.worker.note;
 f.worker.note=async(id,m)=>{await note(id,m);if(m.phase==='wake_reserved'){f.store.rows.get(id).state='blocked';f.store.rows.get(id).blockedOn='human:decision';}};
 assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');assert.equal(f.native.calls.length,0);
 const child=(await f.worker.children(f.id,event.owner))[0];assert.equal(child.blockedOn,'human:decision');
});
test('unsupported human metadata, fake owner and private source errors do not leak or send',async()=>{
 const f=await setup();await assert.rejects(enqueueMachineEvent(f.producer,{...event,project:'fixture,gate:human'}));
 f.delivery.payloadReader=async()=>{throw new Error('PRIVATE_SOURCE_VALUE');};
 await assert.rejects(f.delivery.deliver(f.id),e=>e.message==='payload_source_unavailable'&&!String(e).includes('PRIVATE_SOURCE_VALUE'));
 f.store.rows.get(f.id).body='PRIVATE_INVALID_JSON';
 assert.equal((await f.delivery.deliver(f.id)).outcome,'unknown');
 assert.equal(f.native.calls.length,0);
});
test('invalid UTF8 or oversized facts are not silently rewritten into durable knowledge',async t=>{
 const root=mkdtempSync(join(tmpdir(),'toolrig-d-utf8-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'evidence.md');writeFileSync(path,Buffer.from([0xff,0xfe]));
 assert(readTaskRefs(['file:'+path+':L1'],[root]).sources[0].status.startsWith('not_read'));
 const f=await setup(),work=(await f.delivery.deliver(f.id)).qitemId;
 await assert.rejects(consumeMachineEvent(f.worker,work,{eventId:event.eventId,facts:Array.from({length:5},()=>({value:'x'.repeat(1000),sourceRef:'fixture:issuer'}))}),/too_large/);
 assert.equal((await f.worker.read(work)).state,'pending');
});

test('native return can use the same typed transport and final native continuation does not recurse',async()=>{
 const f=await setup();const work=(await f.delivery.deliver(f.id)).qitemId;
 await consumeMachineEvent(f.worker,work,{eventId:event.eventId});
 const returned=await returnMachineEvent(f.worker,work,'Result remains UNKNOWN, units USD.');
 const sourceBinding={seat:event.producer,nodeId:'producer-node',generation:'producer-generation',threadId:'original-producer-thread'};
 const sourceChannel=channel({},sourceBinding);
 const sourceDelivery=new MachineDelivery({queue:f.producer,channel:sourceChannel,payloadReader:async()=>{throw new Error('return_does_not_reread_payload');}});
 const typedReturn=await sourceDelivery.deliver(returned.qitemId);assert.equal(typedReturn.outcome,'wake_accepted');
 const data=JSON.parse(sourceChannel.calls[0].toolOutput.output);assert.equal(data.direction,'return');assert.equal(data.raw,'Result remains UNKNOWN, units USD.');
 await consumeMachineEvent(f.producer,typedReturn.qitemId,{eventId:event.eventId});
 const count=f.store.rows.size;
 const final=await returnMachineEvent(f.producer,typedReturn.qitemId,'Return recorded; original obligation retained.');
 assert.equal(final.outcome,'return_consumed_native');assert.equal(final.originalObligation,event.sourceTask);
 assert.equal(f.store.rows.size,count);assert.equal((await returnMachineEvent(f.producer,typedReturn.qitemId,'Return recorded; original obligation retained.')).outcome,'return_consumed_native');
});

test('ordinary wakes are not applicable before parsing; malformed tagged events fail closed',async()=>{
 const f=await setup();const id='ordinary';
 f.store.rows.set(id,{qitemId:id,destinationSession:binding.seat,state:'pending',tags:null,body:'Ordinary human queue instruction, not JSON.'});
 assert.equal((await f.delivery.deliver(id)).outcome,'not_applicable');
 assert.equal(f.store.calls.filter(c=>['claim','handoff','note'].includes(c[0])).length,0);
 assert.equal(f.native.calls.length,0);
 f.store.rows.get(id).tags=['machine:d-v1'];
 assert.equal((await f.delivery.deliver(id)).outcome,'unknown');
 assert.equal(f.store.calls.filter(c=>['claim','handoff','note'].includes(c[0])).length,0);
 assert.equal(f.native.calls.length,0);
});

test('SDK MCP consumer reads durable recall and checkpoints only its owned event',async()=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {registerDTools}=await import('../src/d/mcp.js');
 const f=await setup(),work=(await f.delivery.deliver(f.id)).qitemId;
 const server=new McpServer({name:'fixture-d',version:'1'}),client=new Client({name:'fixture-consumer',version:'1'});
 registerDTools(server,f.worker);const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const consumed=await client.callTool({name:'machine_consume',arguments:{qitem:work,event_id:event.eventId}});
  assert.equal(consumed.structuredContent.outcome,'consumed');
  const recalled=await client.callTool({name:'machine_recall',arguments:{qitem:work}});
  assert.equal(recalled.structuredContent.intentRef,event.intentRef);assert.equal(recalled.structuredContent.consumed,true);
  const denied=await client.callTool({name:'task_trace',arguments:{qitem:event.sourceTask}});
  assert.equal(denied.isError,true);
  assert.equal(JSON.stringify(recalled).includes(raw),false);
 } finally {await client.close();await server.close();}
});
