#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StateTool } from './state/tool.js';
try {
  const { values } = parseArgs({ options: { rig: { type: 'string' }, project: { type: 'string' },
    filter: { type: 'string' }, seat: { type: 'string' }, cursor: { type: 'string' } } });
  const result = await new StateTool().snapshot({ rig: values.rig, project: values.project,
    filter: { states: values.filter, ...(values.seat ? { seat: values.seat } : {}) },
    ...(values.cursor !== undefined ? { cursor: values.cursor } : {}) });
  console.log(JSON.stringify(result));
  if (result.status !== 'ok') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: 'error', error: ['native_consumer_identity_unavailable',
    'scope_not_supported_for_native_consumer'].includes(error.message) ? error.message : 'invalid_request_or_source_failure',
    usage: 'node state-cli.js --rig <current-rig> --project <tag-or-repo> --filter active|all [--seat <seat@rig>] [--cursor <opaque>]' }));
  process.exitCode = 1;
}
