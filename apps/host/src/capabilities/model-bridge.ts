// capabilities/model-bridge.ts（S17b 批次4）：模型工具桥——catalog/define/invoke 与
// 工具生命周期外壳（start/result 事件、memory_only 通话门、背景准入记账、registry 路由）。
// 自 runtime/host-tools.ts 整体迁入：路由只走 Registry（48 工具唯一路径），业务 handler
// 在 modules/<域>/；unknown 恢复与引用核对委托 memory 域窄端口。
import { isVoiceCallActive } from '../modules/voice/call-service.ts';
import type { Db } from '../db/connection.ts';
import { ContractError } from '../runtime/or-contract.ts';
import { canDrawHeartbeat, HEARTBEAT_DRAW_TOOL } from '../modules/heartbeat/service.ts';
import { modelFailure } from '../runtime/model-results.ts';
import { storedToolset, definitionId, definitionWasSeen, modelDefinitionAfterBindingRetirement, type WindowToolset } from '../runtime/tool-discovery.ts';
import { searchToolCatalog, toolCatalogIntent } from '../runtime/tool-catalog-search.ts';
import { DISCOVERY_NAMES, effectiveToolName } from '../runtime/tool-discovery.ts';
import { canDiscoverTurnCompletion, readTurnCompletion, TURN_COMPLETION_TOOL } from '../runtime/turn-completion.ts';
import { quoteBackgroundTool } from '../runtime/background-tool-cost.ts';
import type { HostToolSpec, SeenRef, ToolExecContext, ToolExecResult } from './contracts.ts';
import type { CapabilityRegistry } from './registry.ts';
import { executeRegisteredCapability } from './executor.ts';
import { validateArgsAgainstSchema } from './validation.ts';
import { decodeModelArguments, escapedHanArgumentField } from './model-arguments.ts';
export { DISCOVERY_META, isDiscoveryFree } from './model-bridge-meta.ts';
import { DISCOVERY_META, isDiscoveryFree, toolPresentation } from './model-bridge-meta.ts';

export class ModelToolBridge {
  private db: Db;

  constructor(deps: { db: Db; events?: import('../events/service.ts').EventService | null }) {
    this.db = deps.db;
    this.events = deps.events ?? null;
  }

  private events: import('../events/service.ts').EventService | null;
  /** WAKE_KEEPWARM_V1（04）：wake_manage 与 HTTP 管理面共用的预约正本（未注入=工具如实拒绝） */
  /** P02.6：已迁能力注册表（未注入=全部走旧路径，装配前零变化） */
  private capabilityRegistry: CapabilityRegistry | null = null;
  /** P02.6：装配根注入已迁能力注册表（显式创建，非自动发现）。 */
  setCapabilityRegistry(r: CapabilityRegistry | null): void { this.capabilityRegistry = r; }
  /** 架构检查/测试注入面：只读当前注册表快照（不授予执行权）。 */
  getCapabilityRegistry(): CapabilityRegistry | null { return this.capabilityRegistry; }

  /** P04：换窗评审的未知写结果恢复——窄委托 memory 域服务（P06 收口执行边界）。 */
  private memoryRecovery: { recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> } | null = null;
  setMemoryRecovery(s: { recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> } | null): void { this.memoryRecovery = s; }
  async prepareWindowDefinitions(signal?: AbortSignal): Promise<void> {
    await (this.memoryRecovery as {prepareDefinitions?: (signal?:AbortSignal)=>Promise<void>} | null)?.prepareDefinitions?.(signal);
  }
  async recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> {
    if (!this.memoryRecovery) throw new Error('MEMORY_RECOVERY_NOT_WIRED');
    return this.memoryRecovery.recoverUnknownEffects(conversationId, windowId);
  }

  /** P04：引用核对（勾选式话语录入的可见性/重叠/码点口径）——窄委托 memory 域服务。 */
  resolveQuoteRefs(roomId: string, seenMessages: ReadonlyArray<import('../capabilities/contracts.ts').SeenRef>, refs: Array<{ seq: number; from?: number; to?: number }>): unknown {
    if (!this.memoryRecovery) throw new Error('MEMORY_RECOVERY_NOT_WIRED');
    return (this.memoryRecovery as unknown as { resolveQuoteRefs: (r: string, s: ReadonlyArray<never>, refs: never) => unknown }).resolveQuoteRefs(roomId, seenMessages as never, refs as never);
  }
  /** JOINT-VOICE-20261022（07）：媒体语义索引（worker 未配置=能力如实 unavailable） */
  private voiceCallActive(roomId: string): boolean {
    return isVoiceCallActive(this.db, roomId); // E02：单一窄能力（voice/call-service），不再手写表结构 SQL
  }

  /** 协议①（2026-10-24）：通话控制——拨号动作的 est 授权入口（03 §2：复用延迟发现，
   *  不铺细碎工具）。invite=当前会话创建 Siren 来电邀请（服务端过期；拒接≠未接）；
   *  status=查询当前邀请。勿扰/禁拨号在 Siren 服务端执行（本批未加开关=不设静默拦截）。 */
  /** JOINT-VOICE-20261022（07）：中文找图——先补齐本会话未索引图片（有界），再查候选。
   *  权限门在查询 join（活资产+会话绑定）；worker 故障=能力 unavailable，不拖聊天/电话。 */
  /** JOINT-VOICE-20261022：读深听结果（概览/逐字谱分页）。 */
  // R3″（2026-10-24，RE-07/08/09 返修）：三道边界——
  //  ① 源权限：转写必须挂在**本会话当前修订的已发布消息附件**上（voice presentation）；
  //     未发送草稿、已被新修订移除附件的旧引用一律拒读（不用 transcript.conversation_id
  //     替代已发送范围——上轮反例：从未发布的草稿转写可直接读）。
  //  ② 字节预算：页按紧凑 JSON 序列化 UTF-8 字节切（含包装与游标），4 字节汉字/转义
  //     不再凭 2400 字符假定破 8192B 门。
  //  ③ 快照游标：cursor 绑定转写内容身份（derived_text 的 sha256）+ 总字数——等长改写
  //     （甲→乙）也能检出旧游标失效（音频 hash 只代表资产身份，不代表转写版本）。
  /** R5（2026-10-23）：oído 六工具 façade 补齐——capabilities/view/find/compare。
   *  view/find/compare 与 get 同门：analysis/源必须绑定当前会话（oidoSourceAllowed），
   *  前后复验；view 的原生图块直送主模型尚未接通（如实声明，图供界面）。 */
  async execute(name: string, rawArgs: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    const effectiveName = effectiveToolName(name, rawArgs);
    if (ctx.signal?.aborted && effectiveName !== TURN_COMPLETION_TOOL) return { ok: false, output: { error_code: 'CANCELLED' } };
    if (ctx.attemptId && ctx.turnId && effectiveName !== TURN_COMPLETION_TOOL
        && readTurnCompletion(this.db, ctx.attemptId, ctx.turnId) !== null) {
      return { ok: false, output: { error_code: 'TURN_COMPLETED', executed: false } };
    }
    // R07（审计 FE-12）：工具生命周期事件合同——同一身份贯穿
    // start/result/error 三阶段；执行前后各一次真实回执，0 假成功
    // （ok/error_code 如实来自执行结果）。身份=tool_call_id+turn+attempt+
    // request+generation+round；副作用仍只由执行器（executeInner）拥有。
    // S17b 批次3：事件元数据与资格读 descriptor（业务静态表已删）；discovery 入口读自身元数据
    const descriptor = this.capabilityRegistry?.get(name) ?? null;
    const discoveryMeta = descriptor ? null : (DISCOVERY_META[name] ?? null);
    const silent = descriptor ? descriptor.silent : (discoveryMeta?.silent ?? false);
    const presentation = toolPresentation(this.capabilityRegistry, name, rawArgs);
    const visible = !silent && ctx.turnId;
    const identity = () => ({
      tool: name,
      ...presentation,
      tool_call_id: ctx.toolCallId ?? null, // S17b 批次4：身份只走可信 ctx
      turn_id: ctx.turnId,
      attempt_id: ctx.attemptId ?? null,
      request_id: ctx.requestId,
      generation_id: ctx.generationId ?? null,
      round: ctx.round ?? null,
    });
    if (visible) {
      this.events?.publish('turn.tool', {
        conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
        payload: { ...identity(), phase: 'start' },
      });
    }
    // A04（2026-10-24）：通话 memory_only——catalog/define/invoke/直接执行/执行前最后边界
    // 同一策略（effective name 判定）；仅约束模型发起的调用（ctx.turnId 非空），UI/宿主内部调用不受限
    if (ctx.turnId && effectiveName !== TURN_COMPLETION_TOOL) {
      if (this.voiceCallActive(ctx.roomId) && !this.isMemoryOnlyAllowed(effectiveName)) {
        return { ok: false, output: modelFailure({ error_code: 'TOOL_UNAVAILABLE_IN_CALL', detail: '通话期间非记忆业务工具已关闭（memory_only）；挂断后恢复' }) };
      }
    }
    let result: ToolExecResult;
    try {
      result = await this.executeInner(name, rawArgs, ctx);
    } catch (err) {
      if (visible) {
        this.events?.publish('turn.tool', {
          conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
          payload: { ...identity(), phase: 'error', error: String((err as Error).message ?? err).slice(0, 160) },
        });
      }
      throw err;
    }
    if (visible) {
      this.events?.publish('turn.tool', {
        conversationId: ctx.roomId, turnId: ctx.turnId, scope: 'private',
        payload: { ...identity(), phase: 'result', ok: Boolean(result.ok), error_code: (result.output as { error_code?: string }).error_code ?? null },
      });
    }
    // P04 收尾：全部 48 静态业务工具已迁 registry——成功/失败投影在执行外壳内完成唯一一次；
    // 外层不再有第二投影点（model-results.ts 仅余通用失败映射，由外壳调用）。
    return result;
  }

  private async executeDiscovery(name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> {
    const set = storedToolset(this.db, ctx.windowId);
    const deny = (code: string): ToolExecResult => ({ok:false,output:{error_code:code}});
    if (!set || set.protocol === 'legacy') return deny('TOOL_PROTOCOL_NOT_ACTIVE');
    const wire = set.tools.find(t => t.function.name === name);
    if (!wire) return deny('TOOL_PROTOCOL_NOT_ACTIVE');
    if (name === 'tool_catalog') {
      const checked = validateArgsAgainstSchema(args, wire.function.parameters);
      if (!checked.ok) return { ok: false, output: { error_code: checked.code, error: checked.detail } };
      this.admitBackgroundTool(name, ctx);
      // 新目录服从当前能力与请求的活动任务范围，已发送的冻结快照及历史仍按原样保留。
      const inCall = Boolean(ctx.turnId) && this.voiceCallActive(ctx.roomId);
      const listing = set.catalog.flatMap(frozen => {
        const toolName = frozen.function.name;
        if (inCall && !this.isMemoryOnlyAllowed(toolName)) return [];
        const spec = set.protocol === 'direct'
          ? this.directWindowDefinition(set, toolName, ctx)
          : this.taskScopeAllows(toolName, ctx) ? this.visibleFrozenDefinition(frozen) : null;
        return spec ? [spec] : [];
      });
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query) return { ok: true, output: searchToolCatalog(listing, query, set.groups) };
      return { ok: true, output: { tools: listing.map(({ function: definition }) => ({
        name: definition.name,
        description: toolCatalogIntent(definition.name) ?? definition.description.split(/[。\n]/)[0],
      })) } };
    }
    const allowed = name === 'tool_define' ? ['name'] : ['name', 'definition_id', 'arguments'];
    if (Object.keys(args).some(k => !allowed.includes(k))) return deny('TOOL_ARG_UNKNOWN');
    const frozen = set.catalog.find(t => t.function.name === args.name);
    if (!frozen) return deny('TOOL_NOT_IN_ALLOWLIST');
    const spec = set.protocol === 'direct'
      ? this.directWindowDefinition(set, frozen.function.name, ctx)
      : this.visibleFrozenDefinition(frozen);
    if (!spec) return deny('TOOL_NOT_IN_ALLOWLIST');
    // D39（审计 B1 修复，2026-10-25）：catalog/define/invoke/直接执行四处同一通话资格判定——
    // 通话内非记忆业务工具的 define 也返回 TOOL_UNAVAILABLE_IN_CALL（旧实现只在 invoke/直接执行设门，
    // 定义本体可完整进入下一模型请求）；already_available 回执同门。
    if (name === 'tool_define' && this.voiceCallActive(ctx.roomId) && ctx.turnId && !this.isMemoryOnlyAllowed(spec.function.name)) {
      return { ok: false, output: modelFailure({ error_code: 'TOOL_UNAVAILABLE_IN_CALL', detail: '通话期间非记忆业务工具已关闭（memory_only）；挂断后恢复' }) };
    }
    if (name === 'tool_define') {
      if (set.protocol === 'deferred' && !this.taskScopeAllows(spec.function.name, ctx)) return deny('TOOL_NOT_IN_ALLOWLIST');
      this.admitBackgroundTool(name, ctx);
      if (definitionWasSeen(this.db,ctx,spec)) return {ok:true,output:{name:spec.function.name,definition_id:definitionId(spec),already_available:true}};
      return {ok:true,output:{definition_id:definitionId(spec),...spec.function}};
    }
    // P6（四仓审计 20261106，U01/R11）：定义阅读凭证不再是授权——tool_invoke 不带
    // definition_id 也直接执行（参数仍按冻结 schema 完整校验；registry 决定真实权限）。
    // 携带 definition_id 且与冻结版本不符=过期/幻觉版本，如实拒绝（冻结版本校验保留）。
    if (typeof args.definition_id === 'string' && args.definition_id !== definitionId(spec) && args.definition_id !== definitionId(frozen)) {
      return deny('TOOL_DEFINITION_STALE');
    }
    const input = decodeModelArguments(spec.function.name, args.arguments);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, output: { error_code: 'TOOL_ARG_TYPE', field: 'arguments', retryable: true,
        detail: '未执行工具。请按工具定义重新提交 arguments 参数对象。' } };
    }
    if (Object.keys(input).some(k => k.startsWith('__'))) return deny('TOOL_ARG_UNKNOWN');
    // Old hold attachments are already inert. Accept a saved old contract so
    // a remembered attachment does not cause the ordinary memory write to fail.
    const executionSpec = spec.function.name === 'memory_hold' ? frozen : spec;
    return this.executeInner(spec.function.name, input as Record<string, unknown>, ctx, executionSpec, true);
  }

  /** 任务定义根据宿主上下文与现行活动状态交付，执行仍由各业务能力负责。 */
  private taskScopeAllows(name: string, ctx: ToolExecContext, mode: 'deferred' | 'direct' | 'direct_execution' = 'deferred'): boolean {
    switch (name) {
      case 'context_review_complete':
        return ctx.purpose === 'pre_rotate_review' && Boolean(ctx.activeReviewId && this.db.prepare(`
          SELECT 1 FROM rotation_reviews
          WHERE id = ? AND room_id = ? AND window_id = ?
          AND (status = 'active' OR (? = 1 AND status = 'completed'))
        `).get(ctx.activeReviewId, ctx.roomId, ctx.windowId, mode === 'direct_execution' ? 1 : 0));
      case TURN_COMPLETION_TOOL:
        return canDiscoverTurnCompletion(this.db, ctx);
      case HEARTBEAT_DRAW_TOOL:
        return canDrawHeartbeat(this.db, ctx);
      default:
        return this.capabilityRegistry?.get(name)?.group !== 'T';
    }
  }

  /** Standard tools use exactly the window's native wire definition. Task
   * definitions come from the frozen catalog and are only sent in task requests. */
  private directWindowDefinition(set: WindowToolset, name: string, ctx: ToolExecContext, mode: 'direct' | 'direct_execution' = 'direct'): HostToolSpec | null {
    const task = set.groups[name] === 'T';
    // A historical native window carries completion on autonomous requests
    // only. New snapshots advertise it in their ordinary frozen tool list.
    if (name === TURN_COMPLETION_TOOL && task && ctx.purpose !== 'proactive_turn') return null;
    if ((task || name === TURN_COMPLETION_TOOL || name === HEARTBEAT_DRAW_TOOL) && !(name === TURN_COMPLETION_TOOL && mode === 'direct_execution')
        && !this.taskScopeAllows(name, ctx, mode)) return null;
    const frozen = (task ? set.catalog : set.tools).find(spec => spec.function.name === name);
    return frozen ? this.visibleFrozenDefinition(frozen) : null;
  }

  /** 能力退出后，新发的发现结果保留冻结合同中仍可调用的部分。 */
  private visibleFrozenDefinition(spec: HostToolSpec): HostToolSpec | null {
    const definition = spec.function;
    if (!this.capabilityRegistry?.has(definition.name)) return null;
    return modelDefinitionAfterBindingRetirement(spec);
  }

  /** D39：通话 memory_only 资格唯一判定——已迁能力读条目元数据；discovery 入口读自身元数据。
   *  业务静态名单已删（S17b 批次3：单一来源=Registry 条目声明）。 */
  private isMemoryOnlyAllowed(name: string): boolean {
    const d = this.capabilityRegistry?.get(name);
    if (d) return d.memoryOnlyAllowed;
    const meta = DISCOVERY_META[name];
    return meta?.memoryOnlyAllowed ?? false;
  }

  private admitBackgroundTool(name: string, ctx: ToolExecContext): void {
    if (ctx.backgroundRunId && !ctx.beforeBackgroundTool) throw new ContractError('BACKGROUND_TOOL_ADMISSION_MISSING');
    if (ctx.beforeBackgroundTool) {
      // S17b 批次3：discovery 入口免费政策属 discovery（model-bridge）；其余走可信配置报价
      ctx.beforeBackgroundTool(isDiscoveryFree(name) ? { toolName: name, maxCostMicroUsd: 0, verifiedFree: true } : quoteBackgroundTool(this.db, name));
    }
  }

  private async executeInner(name: string, rawArgs: Record<string, unknown>, ctx: ToolExecContext, frozenSpec?: HostToolSpec, viaInvoke = false): Promise<ToolExecResult> {
    if ((DISCOVERY_NAMES as readonly string[]).includes(name)) return this.executeDiscovery(name,rawArgs,ctx);
    if (!frozenSpec) {
      const set = storedToolset(this.db,ctx.windowId);
      if (set?.protocol === 'deferred') return {ok:false,output:{error_code:'USE_TOOL_INVOKE'}};
      if (set?.protocol === 'direct') {
        const directSpec = this.directWindowDefinition(set, name, ctx, 'direct_execution');
        if (!directSpec) return { ok: false, output: { error_code: 'TOOL_NOT_IN_WINDOW' } };
        frozenSpec = directSpec;
      } else if (set) {
        frozenSpec = set.catalog.find(t=>t.function.name===name);
        if (!frozenSpec) return {ok:false,output:{error_code:'TOOL_NOT_IN_WINDOW'}};
        if (name !== 'memory_hold') {
          const liveDefinition = this.visibleFrozenDefinition(frozenSpec);
          if (!liveDefinition) return {ok:false,output:{error_code:'TOOL_NOT_IN_ALLOWLIST'}};
          frozenSpec = liveDefinition;
        }
      }
    }
    // P02.6：名称属于已迁集合 → registry 执行外壳（旧业务分支已删，绝不在新路径失败时回退）。
    // 集合不相交：未迁名显式走下方旧路径。同一定义/handler 只有一个来源。
    if (this.capabilityRegistry?.has(name)) {
      const field = escapedHanArgumentField(name, rawArgs, ctx.argumentSource, viaInvoke);
      if (field) return { ok: false, output: {
        error_code: 'TOOL_ARG_LITERAL_HAN_REQUIRED', field, retryable: true,
        detail: '工具未执行。请保留正文和其他参数，把该字段中的中文直接写成汉字后重新调用。',
      } };
      return executeRegisteredCapability(this.capabilityRegistry.get(name)!, rawArgs, ctx, frozenSpec, {
        db: this.db,
        isVoiceCallActive: (roomId: string) => this.voiceCallActive(roomId),
      });
    }
    // P04 收尾：48 静态业务工具全部经 registry 执行（唯一生产路径；未接线=原 allowlist 拒绝语义）
    return { ok: false, output: { error_code: 'TOOL_NOT_IN_ALLOWLIST' } };
  }

  /** EST_MARIPOSA_AUTO_SURFACING_V1（docs/05）：已见 ref 门+E 侧 ref→
   *  detail_ref 解析+M detail 快照读取。绝不 recall；不建 view_receipt；
   *  结构化错误码原样作为工具结果返回（错误不吞）。 */
  /** 模型指认的引用核对（她的裁定 2026-10-05 + 审计 D13/D16）：
   *  - 只在**发起请求实际装载的 (消息,修订) 清单**里核对（seenMessages），按该修订的正文逐字匹配——
   *    预算裁剪掉的旧文、请求发出后才编辑的新修订，都不在视野内，引用它们=QUOTE_MATCH_FAILED；
   *  - 每条引述独立定位（倒序指认合法）：从最新可见消息向旧搜索，取不与已消费区间重叠的首个出现；
   *    同一消息允许多个互不重叠片段；同一段文字重复引用（区间重叠）会被拒——不产生重复出处；
   *  - 任一条对不上 → 整单拒绝（不替模型圆谎、不静默丢弃）。
   *  匹配用 indexOf（UTF-16 一致，无碍）；发出的 start/end 换算成码点口径（见 MatchedQuote 注释）。 */
  /** 勾选式话语录入（她 2026-10-18 裁定）：模型只报消息序号（可细到句），
   *  宿主从已见原文直接抄录——一字不差是构造出来的，不再做逐字比对。
   *  可见性门保留 D13/O06 语义：只能选真正见过（所见修订号）的内容；
   *  片段级已见（conversation_read 部分阅读）时，勾选必须整段落在已读
   *  码点范围内。重复/重叠勾选拒绝（防同一句录两次）。 */
  /** G-J-01：主模型按需召回——request_ref 由宿主从回合+调用派生（幂等，
   *  模型不能自编）；同 tool_call 重试同 ref（网络重试返回原逻辑结果）。
   *  结果原样有界透传（服务端安全信封/字段投影已在其内）。 */
  /** 召回包统一装配（start/refine/round2 共用）：形状门（R01/WP-04）、
   *  目标回显（找话第一批）、翻页/续查/深搜提示（P12/R02/找话二批）。 */
  /** WP2（MANUAL_HANDOFF_JUDGE_SWITCH_V1）：同结果集翻页——只消费
   *  memory.recall.page 的冻结结果集；不修改查询（refine 是独立动作，
   *  两类引用分槽不互换）；RECALL_POLICY_CHANGED 如实上抛不自动重查。 */
  /** WP4（§7.2，2026-10-08）：主模型只读原文回读。房间从 ToolExecContext
   *  派生（模型不能自填别的房间）；只返回真实 owner 消息与已正式发布的
   *  assistant；system/tool/草稿/UI 思考不在读取面；长单条按码点分片；
   *  sync_state 如实（本地原话可读，不伪造来源身份）；只读零副作用（不推
   *  进 hold 书签、不制造气泡、不触发明开续期）。seenAdditions 供宿主在
   *  片段**实际进入下一模型请求**后并入已见清单（整条/片段范围）。 */
  /** I/计划只读批（2026-10-10）：memory_i_read——I 的当前话/条目/历史
   *  主动读取（此前只有开窗摘要）。M 端 i.get/i.items.list/i.item.get/
   *  i.item.history/i.versions.read 透传；错误如实上抛不吞。 */
  /** I/计划只读批：plans_read——plan.list（列表，可筛状态）与
   *  plan.get（明细，M 薄实现入口）。写操作属下一批。 */
  /** 明确打开/回忆/留链批（2026-10-10）：memory_open——M 的
   *  open→view.confirm→recollections（keep_wide）→keeps 链透传。
   *  语义铁律：召回/回读返回正文 ≠ 明确打开（回温与"留"只经本链）；
   *  confirm/recollect 必须带 open 签发的 view_receipt；谁留谁撤。 */
  /** 纠错批（2026-10-10）：memory_correct——关系/话语来源/原文绑定三族
   *  纠错 + 关系链接/列表 + 纠错台账。写动作宿主派生 es-cor-* 幂等 op；
   *  M 侧按既有合同核验（word_source 的 CAS expected_source_version、
   *  relation/binding 的闭集动作）；错误如实上抛。
   *  2026-10-18 并入：word_add/word_revise——勾选式话语新增/修改，走
   *  mariposa memory.update（就地改入口；expected_version 由宿主先读
   *  memory.get 取当前值；说话人服务端按出处推导）。 */
  /** 删除审批批（2026-10-10）：deletion_review——decide=jiaming 独占
   *  （M 侧权限门保持双层）；模型面只有审批+读（request/withdraw 是
   *  她的权利，经网页提交）。宿主派生 es-del-* 幂等 op。 */
  /** I/计划写入批（2026-10-10）：memory_i_write——I 条目新增/修订/恢复。
   *  M 侧 jiaming 权限+CAS（expected_revision）核验；冲突/校验错误如实
   *  上抛不吞；无物理删除（修订链语义）。 */
  /** I/计划写入批：plans_write——计划创建/修改/完成/放弃。
   *  create/update 宿主派生 es-pw-* 幂等 operation_id；complete/cancel
   *  走 M 薄实现入口；CAS（expected_version）冲突如实上抛。 */
  /** episode_list：模型按需查事件（蓝图 §6.3——scope 内分页，预算内少量）。 */
  /** episode_get：按 ID 读详情。 */
  /** episode_apply（R05 复审 2026-10-07）：五动作写入口。operation_id 宿主
   *  派生（同 tool_call 重试同 op——业务提交后传输回执未完成时，重试回放
   *  原结果不重复建事件）；scope_id=当前房间（模型不能自编范围）。 */
  /** 审计 F08：换窗评审前的有界恢复探测——按原 operation_id 查 hold.status；
   *  有真实回执 → 落 committed + 迟到书签（只补原窗口记录）；completed=false（服务端明确
   *  无提交证据）→ failed_resolved（不是没发生，是可判定的未提交）；查询失败 → 保持 unknown。 */

}
