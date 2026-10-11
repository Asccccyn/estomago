// ESTOMAGO_CHAT_EXEC_V1 §03.9.2（WP7）：外部服务静态注册——每个条目写明传输/凭据/状态。
// 不把远端 JS/shell 当可执行插件；不做万能调用器。
export type IntegrationEntry = {
  serviceId: string;
  transport: 'http' | 'mcp';
  baseUrl: string | null; // null=未配置
  credentialRef: string | null; // 环境变量名（值只在服务端 transport 读取）
  allowedTools: string[];
  timeoutMs: number;
  producesExternalWrites: boolean;
  producesPaidCalls: boolean;
  status: 'not_configured' | 'contract_unverified' | 'available' | 'error';
  statusDetail: string | null;
};

/** 首版静态注册表——按配置文件与实际可达性生成。 */
export function integrationRegistry(config: {
  mariposaBaseUrl: string | null;
  sirenBaseUrl: string | null;
  superpositionBaseUrl: string | null;
  zashideleBaseUrl: string | null;
}): IntegrationEntry[] {
  return [
    {
      serviceId: 'mariposa', transport: 'http', baseUrl: config.mariposaBaseUrl,
      credentialRef: 'MARIPOSA_TOKEN', allowedTools: ['memory.hold', 'memory.recall', 'memory.open', 'conversation.read', 'episode.list', 'episode.apply'],
      timeoutMs: 8000, producesExternalWrites: true, producesPaidCalls: false,
      status: config.mariposaBaseUrl ? 'available' : 'not_configured', statusDetail: null,
    },
    {
      serviceId: 'siren', transport: 'http', baseUrl: config.sirenBaseUrl,
      credentialRef: 'SIREN_TOKEN', allowedTools: [],
      timeoutMs: 15000, producesExternalWrites: false, producesPaidCalls: false,
      status: config.sirenBaseUrl ? 'contract_unverified' : 'not_configured',
      statusDetail: '语音转写/合成合同待核——不做真实调用冒充已接通',
    },
    {
      serviceId: 'superposition', transport: 'http', baseUrl: config.superpositionBaseUrl,
      credentialRef: null, allowedTools: ['stars.list', 'stars.special_dates'],
      timeoutMs: 8000, producesExternalWrites: false, producesPaidCalls: false,
      status: config.superpositionBaseUrl ? 'contract_unverified' : 'not_configured',
      statusDetail: '星星重要日期合同待核——日历读取不触发拆星/消费',
    },
    {
      serviceId: 'zashidele', transport: 'mcp', baseUrl: config.zashideleBaseUrl,
      credentialRef: 'ZASHIDELE_TOKEN', allowedTools: [],
      timeoutMs: 10000, producesExternalWrites: true, producesPaidCalls: false,
      status: config.zashideleBaseUrl ? 'contract_unverified' : 'not_configured',
      statusDetail: '用户指定 MCP 接入——与 est 私密朋友圈完全独立（不共用帖子/评论/发布）',
    },
    {
      serviceId: 'oido', transport: 'mcp', baseUrl: null,
      credentialRef: null, allowedTools: [],
      timeoutMs: 10000, producesExternalWrites: false, producesPaidCalls: false,
      status: 'not_configured', statusDetail: '用户指定 MCP——频谱/听觉业务在其后端；仓库无其当前代码',
    },
    {
      serviceId: 'antinomy', transport: 'http', baseUrl: null,
      credentialRef: null, allowedTools: [],
      timeoutMs: 8000, producesExternalWrites: false, producesPaidCalls: false,
      status: 'not_configured', statusDetail: '现有共度后端——按实际接口挂接阅读工具与入口',
    },
  ];
}
