import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4-mini';

// Regression: https://github.com/obra/knowledge-graph/issues/2
// z.unknown() lacks _zod metadata in Zod v4, crashing toJSONSchema().
// The MCP SDK calls toJSONSchema() on every tool schema during tools/list,
// so one bad schema silently hides all tools from clients.
describe('Zod v4 JSON Schema serialization', () => {
  it('kg_create_node frontmatter param serializes without error', () => {
    // Must match the schema in src/mcp/index.ts kg_create_node tool
    const frontmatter = z.record(z.string(), z.any()).optional();
    expect(() => toJSONSchema(z.object({ frontmatter }))).not.toThrow();
  });

  it('z.record(z.unknown()) crashes — documents the upstream bug', () => {
    // When this stops throwing, the Zod bug is fixed upstream
    expect(() => toJSONSchema(z.object({ f: z.record(z.unknown()) }))).toThrow();
  });
});
