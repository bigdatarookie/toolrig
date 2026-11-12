import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'toolrig-consumer', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp.js', import.meta.url))], env: process.env }));
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'availability_status')) throw new Error('availability_status_not_discovered');
  const result = await client.callTool({ name: 'availability_status', arguments: {} });
  console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
