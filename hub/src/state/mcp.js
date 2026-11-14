import { z } from 'zod';
import { filterSchema } from './projection.js';
import { StateTool } from './tool.js';
export function registerStateTool(server, tool = new StateTool()) {
  server.registerTool('state_snapshot', {
    description: 'Read compact project or explicit owner/ID native metadata baseline or cursor delta. No bodies, transcripts or native writes. Cursor is comparison cache, not authority.',
    inputSchema: { rig: z.string().min(1), project: z.string().min(1),
      filter: filterSchema, cursor: z.string().max(200).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    try {
      const result = await tool.snapshot(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        ...(result.status === 'partial' ? { isError: true } : {}) };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'state_read_failed: verify native consumer identity, own rig, project/filter and source coverage' }] };
    }
  });
}
