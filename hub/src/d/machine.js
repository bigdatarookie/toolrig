import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compactReceipt, writeThenReconcile } from './receipts.js';
const text = z.string().min(1).max(1000);
const eventId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const bindingSchema = z.strictObject({ seat: text, nodeId: text, generation: text, threadId: text });
export const eventSchema = z.strictObject({ version: z.literal(1), kind: z.enum(['machine_delivery','machine_work','machine_return','machine_return_work']),
  eventId, project: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), producer: text, owner: text, sourceTask: text, intentRef: text,
  nextAction: z.strictObject({ value: text, sourceRef: text }), sourceRefs: z.array(text).min(1).max(16),
  payloadRef: text, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  binding: bindingSchema.optional(), deliveryParent: text.optional(), conclusion: text.optional() });
export const digest = raw => createHash('sha256').update(raw).digest('hex');
export const deliveryId = event => 'qitem-machine-'+digest(JSON.stringify([event.producer,event.owner,event.eventId])).slice(0,32);
const active = q => ['pending','in-progress'].includes(q.state);
const body = q => { try { return eventSchema.parse(JSON.parse(q.body)); } catch { throw new Error('machine_event_metadata_invalid'); } };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const unknown = id => ({ operationId:id, outcome:'unknown', action:'reconcile_same_operation; do_not_replay' });
async function actor(queue, q) {
  const identity = await queue.identity();
  if (identity.sessionName !== q.destinationSession) throw new Error('native_owner_mismatch');
  return identity;
}
async function markers(queue, q, event) {
  return (await queue.journal(q.qitemId)).flatMap(row => {
    if (row.actorSession !== q.destinationSession || !row.transitionNote?.startsWith('toolrig-d/1 ')) return [];
    try { const m=JSON.parse(row.transitionNote.slice('toolrig-d/1 '.length)); return m.eventId === event.eventId ? [m] : []; } catch { return []; }
  });
}
export async function enqueueMachineEvent(queue, input) {
  if ((input.kind !== undefined && input.kind !== 'machine_delivery') || input.binding || input.deliveryParent || input.conclusion) throw new Error('not_machine_delivery_metadata');
  const event = eventSchema.parse({ ...input, version:1, kind:'machine_delivery' });
  const identity = await queue.identity(), parent = await queue.read(event.sourceTask);
  if (identity.sessionName !== event.producer || parent.destinationSession !== event.producer) throw new Error('producer_task_owner_mismatch');
  if (!(parent.tags?.includes('project:'+event.project) || parent.targetRepo === event.project)) throw new Error('source_task_scope_unknown');
  const id = deliveryId(event);
  const project = q => {
    if(q?.qitemId!==id || q.destinationSession!==event.owner || !same(body(q),event))throw new Error('event_id_conflict_or_unknown');
    return {...compactReceipt(id,q),eventId:event.eventId,machineTransport:'not_confirmed; native_pending_or_compact_fallback'};
  };
  // Look up the stable native ID first. Unavailable is not permission to write.
  // A repeated completed create is observed without another write or nudge.
  const existing=await queue.find(id);
  if(existing)return project(existing);
  return writeThenReconcile(id,async()=>project(await queue.create(id,event.owner,event)),async()=>project(await queue.read(id)));
}
export class MachineDelivery {
  constructor({ queue, channel, payloadReader }) { Object.assign(this,{queue,channel,payloadReader}); }
  async deliver(id) {
    const {queue,channel} = this;
    const q = await queue.read(id);
    // The native dispatcher visits ordinary wakes too. Select only canonical
    // machine-tagged rows before interpreting any body or touching delivery.
    if (!Array.isArray(q.tags) || !q.tags.includes('machine:d-v1')) return { operationId:id, outcome:'not_applicable' };
    let e;
    try { e=body(q); } catch { return unknown(id); }
    const identity = await actor(queue,q);
    if (e.owner !== q.destinationSession) throw new Error('event_owner_mismatch');
    if (!['machine_delivery','machine_return'].includes(e.kind) || q.state !== 'pending') return this.reconcile(id);
    if (!channel?.assertCurrent || !channel.send || !channel.reconcile) return { ...compactReceipt(id,q), machineTransport:'NOT_IMPLEMENTED', action:'existing_compact_native_fallback' };
    let binding;
    try { binding=bindingSchema.parse(await channel.assertCurrent(e.owner)); }
    catch { return { ...compactReceipt(id,q), machineTransport:'unavailable', action:'preserve_native_obligation' }; }
    if (binding.seat !== e.owner || binding.nodeId !== identity.nodeId) throw new Error('runtime_binding_mismatch');
    let raw;
    try { raw=e.kind==='machine_return'?e.conclusion:await this.payloadReader(e.payloadRef); } catch { throw new Error('payload_source_unavailable'); }
    if (typeof raw !== 'string' || Buffer.byteLength(raw)>65536 || (e.kind!=='machine_return'&&digest(raw)!==e.payloadDigest)) throw new Error('payload_ref_digest_or_limit_invalid');
    // Native claim is the only CAS/lease. Exactly one caller gets launch rights.
    try { await queue.claim(id); } catch { return this.reconcile(id); }
    let work;
    try {
      work=await queue.handoff(id,e.owner,{...e,kind:e.kind==='machine_return'?'machine_return_work':'machine_work',binding,deliveryParent:id},{nudge:false});
      await queue.note(work.qitemId,{eventId:e.eventId,phase:'wake_reserved',binding});
      const current=bindingSchema.parse(await channel.assertCurrent(e.owner));
      if (!same(current,binding)) return unknown(id);
      const live=await queue.read(work.qitemId);
      if (live.state!=='pending' || live.blockedOn || live.destinationSession!==binding.seat) return unknown(id);
      const output=JSON.stringify({eventId:e.eventId,operationId:id,obligationId:work.qitemId,intentRef:e.intentRef,
        nextAction:e.nextAction,sourceRefs:e.sourceRefs,direction:e.kind==='machine_return'?'return':'incoming',raw});
      const receipt=await channel.send({operationId:id,eventId:e.eventId,obligationId:work.qitemId,binding,
        toolOutput:{name:'openrig_events',output,retain:false}});
      if (receipt?.status!=='accepted' || receipt.transport!=='toolOutput' || receipt.retain!==false ||
          !same(bindingSchema.parse(receipt.binding),binding) || typeof receipt.turnId!=='string' || typeof receipt.requestId!=='string') return unknown(id);
      const noted=await queue.note(work.qitemId,{eventId:e.eventId,phase:'wake_accepted',binding,turnId:receipt.turnId,requestId:receipt.requestId});
      if(noted?.qitemId!==work.qitemId||noted.destinationSession!==binding.seat)return unknown(id);
      return { ...compactReceipt(id,noted,{outcome:'wake_accepted'}),eventId:e.eventId,transport:'toolOutput',retain:false,
        requestId:receipt.requestId, turnId:receipt.turnId, consumed:null, nextAction:e.nextAction };
    } catch { return unknown(id); }
  }
  async reconcile(id) {
    // Read-only same-operation reconciliation; never start/claim/handoff again.
    try {
      const q=await this.queue.read(id),e=body(q);await actor(this.queue,q);
      if (q.state==='pending') return {...compactReceipt(id,q,{outcome:'not_reserved'}),eventId:e.eventId};
      const children=await this.queue.children(id,e.owner);
      if (children.length!==1) return unknown(id);
      const work=await this.queue.read(children[0].qitemId),w=body(work);
      if (w.deliveryParent!==id || w.eventId!==e.eventId) return unknown(id);
      const journal=await markers(this.queue,work,w);
      const consumed=journal.find(m=>m.phase==='consumed');
      const accepted=journal.find(m=>m.phase==='wake_accepted');
      if (consumed || accepted) return {...compactReceipt(id,work,{outcome:consumed?'consumed':'wake_accepted'}),eventId:e.eventId,
        transport:accepted?'toolOutput':'unconfirmed',requestId:accepted?.requestId,turnId:accepted?.turnId,sourceRefs:e.sourceRefs};
      const receipt=await this.channel?.reconcile?.({operationId:id,eventId:e.eventId,obligationId:work.qitemId,binding:w.binding});
      if (receipt?.status==='accepted' && receipt.transport==='toolOutput' && receipt.retain===false &&
          same(bindingSchema.parse(receipt.binding),w.binding) && typeof receipt.turnId==='string') return {
        ...compactReceipt(id,work,{outcome:'wake_accepted_runtime_receipt'}),eventId:e.eventId,consumed:null,requestId:receipt.requestId,turnId:receipt.turnId };
      return unknown(id);
    } catch { return unknown(id); }
  }
}
export async function consumeMachineEvent(queue,id,{eventId:expected,facts=[]}={}) {
  const q=await queue.read(id),e=body(q);await actor(queue,q);
  if(e.owner!==q.destinationSession)throw new Error('event_owner_mismatch');
  if(!['machine_work','machine_return_work'].includes(e.kind) || e.eventId!==expected)throw new Error('event_obligation_mismatch');
  const previous=await markers(queue,q,e);
  if(previous.some(m=>m.phase==='consumed'))return {...compactReceipt(e.deliveryParent,q,{outcome:'already_consumed'}),eventId:e.eventId,nextAction:e.nextAction,sourceRefs:e.sourceRefs};
  if(q.state!=='pending')return {...unknown(e.deliveryParent),qitemId:id};
  const safeFacts=z.array(z.strictObject({value:text,sourceRef:text})).max(8).parse(facts);
  if(Buffer.byteLength(JSON.stringify(safeFacts))>4096)throw new Error('fact_checkpoint_too_large; use_source_refs');
  if(safeFacts.some(f=>!e.sourceRefs.includes(f.sourceRef)))throw new Error('fact_source_not_in_task');
  try {
    await queue.claim(id);
    await queue.note(id,{eventId:e.eventId,phase:'consumed',facts:safeFacts,intentRef:e.intentRef,sourceRefs:e.sourceRefs});
    return {...compactReceipt(e.deliveryParent,await queue.read(id),{outcome:'consumed'}),eventId:e.eventId,nextAction:e.nextAction};
  } catch { return {...unknown(e.deliveryParent),qitemId:id}; }
}
export async function recallMachineEvent(queue,id) {
  const q=await queue.read(id),e=body(q);await actor(queue,q);
  if(e.owner!==q.destinationSession)throw new Error('event_owner_mismatch');
  const journal=await markers(queue,q,e);
  return {...compactReceipt(e.deliveryParent??id,q),eventId:e.eventId,intentRef:e.intentRef,nextAction:e.nextAction,
    sourceRefs:e.sourceRefs,conclusion:e.conclusion??null,nextActionAppliesTo:['machine_work','machine_return_work'].includes(e.kind)?'current_consumer':'original_machine_work',deliveryParent:e.deliveryParent??null,consumed:journal.some(m=>m.phase==='consumed'),
    facts:journal.filter(m=>m.phase==='consumed').flatMap(m=>m.facts??[]),
    transport:journal.some(m=>m.phase==='wake_accepted')?'toolOutput':'unconfirmed',rawPayloadRetained:false};
}
export async function returnMachineEvent(queue,id,conclusion) {
  const q=await queue.read(id),e=body(q);await actor(queue,q);
  if(e.owner!==q.destinationSession)throw new Error('event_owner_mismatch');
  const summary=text.parse(conclusion);
  if(e.kind==='machine_return_work') {
    const final=record=>{
      if(record.state!=='done'||record.closureReason!=='no-follow-on'||record.resolution!==summary)return unknown(e.deliveryParent);
      return {...compactReceipt(e.deliveryParent,record,{outcome:'return_consumed_native'}),eventId:e.eventId,
        originalObligation:e.sourceTask,action:'continue_original_native_obligation; no_recursive_machine_ack'};
    };
    if(q.state==='done')return final(q);
    if(q.state!=='in-progress'||!(await markers(queue,q,e)).some(m=>m.phase==='consumed'))throw new Error('consume_checkpoint_required');
    try{return final(await queue.complete(id,summary));}catch{return final(await queue.read(id));}
  }
  if(e.kind!=='machine_work')throw new Error('not_machine_work');
  const existing=async()=>{
    const current=await queue.read(id);
    if(current.state!=='done'||current.handedOffTo!==e.producer)return unknown(e.deliveryParent);
    const candidates=await queue.children(id,e.producer);
    if(candidates.length!==1)return unknown(e.deliveryParent);
    const child=await queue.read(candidates[0].qitemId),r=body(child);
    if(r.kind!=='machine_return'||r.eventId!==e.eventId||r.conclusion!==summary)return unknown(e.deliveryParent);
    return {...compactReceipt(e.deliveryParent,child,{outcome:'returned_native'}),eventId:e.eventId,
      nativeReturnTransport:'native_queue_wake; toolOutput_requires_runtime_receipt'};
  };
  if(!active(q))return existing();
  if(q.state!=='in-progress'||!(await markers(queue,q,e)).some(m=>m.phase==='consumed'))throw new Error('consume_checkpoint_required');
  try {
    const child=await queue.handoff(id,e.producer,{...e,kind:'machine_return',owner:e.producer,conclusion:summary,nextAction:{value:'Read the original native obligation and act only within its current authority.',sourceRef:e.intentRef}});
    return {...compactReceipt(e.deliveryParent,child,{outcome:'returned_native'}),eventId:e.eventId,
      nativeReturnTransport:'native_queue_wake; toolOutput_requires_runtime_receipt'};
  } catch { return existing(); }
}

export const createMachineDelivery = options => new MachineDelivery(options);
