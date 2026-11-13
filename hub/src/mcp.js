import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configuredService } from './config.js';
import { configuredDocumentsAdapter, registerDocumentsTools } from './documents.js';
import { registerStateTool } from './state/mcp.js';
import { continuation } from './store.js';

let service;
const getService = () => service ??= configuredService();
const server = new McpServer({ name: 'toolrig-hub', version: '0.1.0' });
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
registerDocumentsTools(server, configuredDocumentsAdapter());
registerStateTool(server);
process.once('SIGTERM', async () => { await server.close(); service?.store.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
