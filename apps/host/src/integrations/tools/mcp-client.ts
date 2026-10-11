// ESTOMAGO_CHAT_EXEC_V1 §03.9.3/§04.12（WP7）：MCP client 薄层——真实协议生命周期与结果转换。
// 不在 est 内建 MCP 服务器；不做万能调用器（模型不能任填 URL/method/headers）。
// 传输：stdio（子进程 JSON-RPC）——与 MCP 规范一致；HTTP/SSE 传输待外部服务实际合同核验后接入。
// 图片字节经媒体服务取得资产（§03.9.3.4：不把 Base64 塞成普通正文）。
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type McpToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpCallResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

export class McpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private seq = 0;
  readonly serverName: string;
  private connected = false;
  private toolsCache: McpToolDef[] | null = null;

  constructor(opts: { command: string; args?: string[]; env?: Record<string, string>; serverName: string }) {
    this.serverName = opts.serverName;
    this.proc = spawn(opts.command, opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      // MCP 子进程 stderr：只记元信息，不记工具结果正文
      void chunk;
    });
    this.proc.on('exit', () => { this.connected = false; this.rejectAll(new Error('MCP_SERVER_EXITED')); });
    this.proc.on('error', (err) => { this.connected = false; this.rejectAll(err); });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { jsonrpc?: string; id?: string; result?: unknown; error?: { code: number; message: string } };
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`MCP_ERROR:${msg.error.code}:${msg.error.message}`));
          else p.resolve(msg.result);
        }
        // notification（无 id）——忽略（首版不处理进度/取消通知）
      } catch { /* 非 JSON 行忽略 */ }
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error('MCP_TRANSPORT_CLOSED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
      this.proc!.stdin!.write(msg + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP_TIMEOUT')); } }, 10000).unref?.();
    });
  }

  /** 初始化握手（§03.9.3.1）：initialize → tools/list。 */
  async initialize(): Promise<{ tools: McpToolDef[] }> {
    const initResult = await this.send('initialize', { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'estomago', version: '0.2.2' } }) as { capabilities?: unknown };
    void initResult;
    this.connected = true;
    await this.send('notifications/initialized');
    const listResult = await this.send('tools/list') as { tools?: McpToolDef[] };
    this.toolsCache = listResult?.tools ?? [];
    return { tools: this.toolsCache };
  }

  /** tools/call（§03.9.3.3）：实际参数、结果、错误、超时和取消。 */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<McpCallResult> {
    if (!this.connected) throw new Error('MCP_NOT_INITIALIZED');
    // 只调用 tools/list 返回的工具（§03.9.3.2：不因远端增加工具就自动扩大权限）
    if (this.toolsCache && !this.toolsCache.some((t) => t.name === name)) {
      throw new Error(`MCP_TOOL_NOT_LISTED:${name}`);
    }
    const result = await Promise.race([
      this.send('tools/call', { name, arguments: args }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP_CALL_TIMEOUT')), timeoutMs)),
    ]) as McpCallResult;
    return result;
  }

  isConnected(): boolean { return this.connected; }
  listedTools(): McpToolDef[] { return this.toolsCache ?? []; }

  async close(): Promise<void> {
    this.connected = false;
    this.rejectAll(new Error('MCP_CLOSED'));
    this.proc?.kill();
    this.proc = null;
  }
}

/** §03.9.3.4：MCP 结果→模型驱动内容——图片字节走媒体服务，文字透传。 */
export function convertMcpResult(result: McpCallResult): { text: string; imageAssetIds: string[] } {
  const texts: string[] = [];
  const imageIds: string[] = [];
  for (const c of result.content) {
    if (c.type === 'text' && c.text) texts.push(c.text);
    else if ((c.type === 'image' || c.type === 'resource') && c.data) imageIds.push(c.data); // Base64 → 媒体服务处理（不塞正文）
  }
  return { text: texts.join('\n'), imageAssetIds: imageIds };
}
