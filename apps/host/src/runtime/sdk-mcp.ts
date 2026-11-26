import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { materializeImage, type ReadModelImage } from '../media/model-input.ts';
import type { HostToolSpec, ToolExecResult } from '../capabilities/contracts.ts';

export const sdkToolName = (name: string): string => `mcp__est__${name}`;

/** The Claude SDK skips MCP tools whose input schema uses a top-level
 * combinator. Native tools expose their ordinary typed fields to the SDK.
 * The complete frozen schema stays in ModelToolBridge for execution. */
export function createEstSdkMcp(
  tools: HostToolSpec[],
  execute: (name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => Promise<ToolExecResult & { recordDelivery?: (result: ToolExecResult) => void }>,
  readImage?: ReadModelImage,
): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name: 'est', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const names = new Set(tools.map(({ function: spec }) => spec.name));
  const native = names.has('tool_catalog') && names.has('tool_define') && !names.has('tool_invoke');
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ function: spec }) => {
      const inputSchema = spec.parameters as { type: 'object'; properties?: Record<string, object> };
      if (!native) return { name: spec.name, description: spec.description, inputSchema };
      const { allOf: _allOf, anyOf: _anyOf, oneOf: _oneOf, ...sdkSchema } = spec.parameters;
      return { name: spec.name, description: spec.description, inputSchema: sdkSchema as typeof inputSchema };
    }),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!tools.some(t => t.function.name === request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: '{"error_code":"TOOL_NOT_IN_WINDOW"}' }] };
    }
    const result = await execute(request.params.name, request.params.arguments ?? {}, request.params._meta);
    let delivered: ToolExecResult = result;
    const images: Array<{type:'image';data:string;mimeType:string}> = [];
    if (result.ok && result.imageRefs?.length) {
      try {
        if (!readImage) throw Error('SDK_MEDIA_TRANSPORT_UNVERIFIED');
        for (const ref of result.imageRefs) {
          const block = await materializeImage(ref, readImage);
          images.push({type:'image',data:block.source.data,mimeType:block.source.media_type});
        }
      } catch (error) {
        delivered = {ok:false,output:{error_code:(error as {code?:string}).code ?? 'SDK_MEDIA_TRANSPORT_UNVERIFIED',detail:'工具已执行，但图片未交付；不能据此声称看到了图片。'}};
        images.length = 0;
      }
    }
    const addition = delivered.ok && delivered.activatedTool;
    if (addition && !tools.some(tool => tool.function.name === addition.function.name)) {
      tools.push(addition);
      await instance.server.sendToolListChanged();
    }
    result.recordDelivery?.(delivered);
    return { isError: !delivered.ok, content: [{ type: 'text' as const, text: JSON.stringify(delivered.output) }, ...images] };
  });
  return { type: 'sdk', name: 'est', instance };
}
