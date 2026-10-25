// server/routes/runtime-settings.ts（P07.2 第四批a）：聊天窗换模型/推理等级路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { fetchOrModelMeta, effortsForModel } from '../../runtime/runtime-settings.ts';
import { orModelIdIssue } from '../../config/schema.ts';
import type { RequestDeps } from '../http.ts';

/** 运行时设置组：GET/PUT /api/v1/runtime-settings。 */
export async function handleRuntimeSettingsRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string): Promise<void> {
// —— 2026-10-08 她裁定：聊天窗换模型/推理等级 ——
const rtGet = route === 'GET /api/v1/runtime-settings';
if (rtGet) {
  const cfg = d.config.openrouter;
  const effModel = d.settings ? d.settings.effectiveOrModel(cfg.model) : cfg.model;
  const effEffort = d.settings ? (d.settings.reasoningEffort() ?? 'default') : 'default';
  // 档位按当前生效模型的真实支持生成（OR 公开元数据；强制思考模型
  // 没有 none/minimal——此前静态全表会在这些模型上吃 400）
  let efforts: string[] | null = null;
  if (d.runnerSelection.status === 'ok' && d.runnerSelection.runner.kind === 'openrouter' && effModel) {
    const meta = await fetchOrModelMeta(cfg.base_url, effModel);
    efforts = effortsForModel(meta, effModel);
  }
  return json(res, 200, {
    driver: d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : 'unknown',
    or_model: { effective: effModel, override: d.settings?.orModel() ?? null, config_default: cfg.model },
    reasoning_effort: { effective: effEffort, override: d.settings?.reasoningEffort() ?? null, config_default: cfg.reasoning },
    model_options: cfg.model_options ?? [],
    effort_options: efforts ?? ['default'],
    effort_options_verified: efforts !== null,
    note: '切模型=运行边界变化，下一条消息将等待历史选集确认后换窗；切思考深度=立即生效，不换窗（上下文复用）',
  });
}
const rtPut = route === 'PUT /api/v1/runtime-settings';
if (rtPut) {
  if (!d.settings) return json(res, 503, { error: { code: 'unavailable', message: '运行时设置服务未接线' } });
  const body = (await readJson(req, d)) as { or_model?: unknown; reasoning_effort?: unknown };
  // WP-04（JFA-B05/CX-10/C-016）：两字段全验通过后一次性写入——
  // 任一失败 422 且零写入（不再逐字段先写先错）；or_model 按配置层
  // 同款形状门（orModelIdIssue：auto/latest/逗号拼单/未知形态拒）
  const nextModel: string | null | undefined = body.or_model !== undefined
    ? (body.or_model === null || body.or_model === ''
        ? null
        : typeof body.or_model === 'string' && body.or_model.trim().length > 0 && body.or_model.length <= 128
          ? body.or_model.trim()
          : undefined)
    : undefined;
  if (body.or_model !== undefined && nextModel === undefined) {
    return json(res, 422, { error: { code: 'invalid_model', message: 'or_model 必须是非空字符串或 null（回落默认）' } });
  }
  if (nextModel !== undefined && nextModel !== null) {
    const issue = orModelIdIssue(nextModel);
    if (issue) return json(res, 422, { error: { code: 'invalid_model', message: issue, field: 'or_model' } });
  }
  let nextEffort: string | null | undefined = body.reasoning_effort !== undefined
    ? (body.reasoning_effort === null || body.reasoning_effort === 'default'
        ? null
        : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort as string)
          ? (body.reasoning_effort as string)
          : undefined)
    : undefined;
  if (body.reasoning_effort !== undefined && nextEffort === undefined) {
    return json(res, 422, { error: { code: 'invalid_effort', message: 'reasoning_effort 必须是 default|none|minimal|low|medium|high|xhigh|max 或 null' } });
  }
  // FU-001（二次回访 2026-10-10）：按合并 patch 后的**真实生效对**
  // 校验——此前 null/default 清除回落配置默认的组合不经校验：
  // 模型清空回落 A+low、档位清空回落 B+high 均被 200 落库。候选
  // 模型=patch ?? override ?? 配置默认；候选档位=patch ?? override
  // ?? 配置默认 effort（含 model-only 继承）。元数据可及时校验；
  // 具体模型优先使用官方已核实档位；未知模型元数据不可达时拒绝新设置。
  const candidateModel = (nextModel !== undefined ? nextModel : d.settings.orModel())
    ?? d.config.openrouter.model;
  const defEffort = (d.config.openrouter.reasoning as { effort?: unknown } | null | undefined)?.effort;
  const defEffortStr = typeof defEffort === 'string' && defEffort !== 'default' ? defEffort : null;
  const candidateEffort = (nextEffort !== undefined ? nextEffort : d.settings.reasoningEffort()) ?? defEffortStr;
  if (candidateEffort !== null && candidateModel) {
    const driver = d.runnerSelection.status === 'ok' ? d.runnerSelection.runner.kind : null;
    if (driver === 'openrouter') {
      const meta = await fetchOrModelMeta(d.config.openrouter.base_url, candidateModel);
      const allowed = effortsForModel(meta, candidateModel);
      if (!allowed) {
        return json(res, 422, { error: { code: 'effort_unverified', message: '当前模型的思考档位尚未核实，请稍后重试' } });
      }
      if (allowed && !allowed.includes(candidateEffort)) {
        return json(res, 422, { error: { code: 'effort_not_supported', message: `候选生效模型 ${candidateModel} 不支持思考档位 ${candidateEffort}`, supported: allowed } });
      }
    }
  }
  // FU-002（回访）：全验通过后**单事务**写入（setMany）——此前两字段
  // 各开事务，第二写失败后第一写已提交（半提交状态）
  const writes: Array<[string, string | null]> = [];
  if (nextModel !== undefined) writes.push(['or_model', nextModel]);
  if (nextEffort !== undefined) writes.push(['reasoning_effort', nextEffort]);
  d.settings.setMany(writes);
  const cfg2 = d.config.openrouter;
  return json(res, 200, {
    or_model: { effective: d.settings.effectiveOrModel(cfg2.model), override: d.settings.orModel() },
    reasoning_effort: { effective: d.settings.reasoningEffort() ?? 'default', override: d.settings.reasoningEffort() },
  });
}
}
