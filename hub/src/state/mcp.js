import { z } from 'zod';
import { StateTool } from './tool.js';
export function registerStateTool(server, tool = new StateTool()) {
  server.registerTool('state_snapshot', {
    description: 'Read compact own-rig/project native metadata baseline or cursor delta. No bodies, transcripts or native writes. Cursor is comparison cache, not authority.',
    inputSchema: { rig: z.string().min(1), project: z.string().min(1),
      filter: z.strictObject({ states: z.enum(['active', 'all']), seat: z.string().optional() }), cursor: z.string().max(200).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    try {
      const result = await tool.snapshot(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        ...(result.status !== 'ok' ? { isError: true } : {}) };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'state_read_failed: verify native consumer identity, own rig, project/filter and source coverage' }] };
    }
  });
}
