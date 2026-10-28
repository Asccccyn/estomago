import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { HostToolSpec, ToolExecResult } from '../capabilities/contracts.ts';

export const sdkToolName = (name: string): string => `mcp__est__${name}`;

/** Keep the registry's JSON Schema intact. Validation and business execution
 * belong to ModelToolBridge (the current HostToolExecutor), not a second Zod schema. */
export function createEstSdkMcp(
  tools: HostToolSpec[],
  execute: (name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => Promise<ToolExecResult>,
): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name: 'est', version: '1.0.0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ function: spec }) => ({
      name: spec.name, description: spec.description,
      inputSchema: spec.parameters as { type: 'object'; properties?: Record<string, object> },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!tools.some(t => t.function.name === request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: '{"error_code":"TOOL_NOT_IN_WINDOW"}' }] };
    }
    const result = await execute(request.params.name, request.params.arguments ?? {}, request.params._meta);
    return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result.output) }] };
  });
  return { type: 'sdk', name: 'est', instance };
}
