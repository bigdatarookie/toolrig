#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readBoundedJson } from './d/input.js';
import { NativeQueue } from './d/native-queue.js';
import { consumeMachineEvent, recallMachineEvent, returnMachineEvent } from './d/machine.js';
import { taskTrace } from './d/task-trace.js';
try {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{qitem:{type:'string'},'event-id':{type:'string'},query:{type:'string'},'outcome-file':{type:'string'},'facts-file':{type:'string'}}});
  const queue=new NativeQueue(),id=values.qitem; if(!id)throw new Error('usage');
  let result;
  if(positionals[0]==='trace')result=await taskTrace(queue,id,{query:values.query??''});
  else if(positionals[0]==='recall')result=await recallMachineEvent(queue,id);
  else if(positionals[0]==='consume') {
    let facts=[];
    if(values['facts-file'])facts=readBoundedJson(values['facts-file']);
    result=await consumeMachineEvent(queue,id,{eventId:values['event-id'],facts});
  }
  else if(positionals[0]==='return') {
    if(!values['outcome-file'])throw new Error('usage');
    result=await returnMachineEvent(queue,id,readBoundedJson(values['outcome-file']).conclusion);
  } else throw new Error('usage');
  console.log(JSON.stringify(result)); if(result.outcome==='unknown')process.exitCode=2;
} catch { console.error(JSON.stringify({outcome:'unavailable',error:'verify_native_owner_task_scope_or_source',usage:'toolrig-d trace|recall|consume|return --qitem ID [--event-id ID] [--query literal] [--outcome-file JSON]'}));process.exitCode=1; }
