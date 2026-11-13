import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { configuredService } from './config.js';
import { createCiDigestService } from './ci-digest.js';
import { configuredDocumentsAdapter, registerDocumentsTools } from './documents.js';
import { registerDTools } from './d/mcp.js';
import { registerStateTool } from './state/mcp.js';
import { continuation } from './store.js';

let service;
const getService = () => service ??= configuredService();
const ciDigest = createCiDigestService({ baseUrl: process.env.TOOLRIG_GITHUB_API_URL });
const server = new McpServer({ name: 'toolrig-hub', version: '0.2.0' });
const call = fn => async args => {
  try {
    const result = await fn(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'availability_request_failed: verify configured home, registry and provider read capability' }] };
  }
};
server.registerTool('availability_status', {
  description: 'Read current configured Codex home account and quota with source/time. No login or inference. Does not attest an already-running seat account.',
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false },
}, call(() => getService().status()));
server.registerTool('availability_request', {
  description: 'Evaluate permitted account policy and persist one shared-home pending continuation. Does not execute auth changes or restart seats.',
  inputSchema: { continuation },
}, call(args => getService().request(args.continuation)));
server.registerTool('ci_digest', {
  description: 'Read a GitHub Actions run/attempt and summarize statuses, failed steps, structured check annotations, and bounded relevant error excerpts. Never reruns, cancels, merges, or changes CI.',
  inputSchema: {
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    run_id: z.number().int().positive(),
    attempt: z.number().int().positive().optional(),
    job_id: z.number().int().positive().optional(),
    pull_request: z.number().int().positive().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async args => {
  const result = await ciDigest.digest(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});
registerDocumentsTools(server, configuredDocumentsAdapter());
registerStateTool(server);
registerDTools(server);
process.once('SIGTERM', async () => { await server.close(); service?.store.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
