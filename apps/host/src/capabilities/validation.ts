// capabilities/validation.ts（P01.2）：通用参数形状校验。
// 从 runtime/host-tools.ts validateToolArgs 的 schema 遍历部分原样提取；错误码逐一保持
//（TOOL_ARG_UNKNOWN/ENUM/TYPE/LENGTH/REQUIRED）。业务约束不在这里——它们属于所属能力
// 的 handler（如 identity_milestone_write 的 change_reason 必填、memory_hold 的心情窗预拒）。
// 正本仍是该窗口冻结 schema（frozenSpec.function.parameters），本文件只做通用遍历。

export type ItemPropSpec = { type?: string; minimum?: number };
export type PropSpec = { type?: string; enum?: unknown[]; items?: { type?: string; enum?: unknown[]; minLength?: number; required?: string[]; properties?: Record<string, ItemPropSpec> }; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number };
export type SchemaShape = { properties?: Record<string, PropSpec>; required?: string[] };

/** PropSpec 顶层 minimum（integer 字段用；与 ItemPropSpec 分开保持类型窄） */
export function propMinimumOf(prop: PropSpec): number | undefined {
  return (prop as PropSpec & { minimum?: number }).minimum;
}

/** 审计 A051/F30：宿主侧最小 JSON-Schema 校验——白名单外字段拒绝（additionalProperties:false），
 *  required 缺失/类型不符/枚举外值/长度与条数越界直接拒绝，不提交给 Mariposa。 */
export function validateArgsAgainstSchema(args: Record<string, unknown>, schema: SchemaShape): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === '__tool_call_id') continue; // 宿主内部标识，非模型参数
    if (v === undefined) continue; // undefined=字段缺席（JSON 里本不存在该键）
    const prop = schema.properties?.[k];
    if (!prop) return { ok: false, code: 'TOOL_ARG_UNKNOWN', detail: `未知参数 ${k}（additionalProperties:false）` };
    if (prop.enum && !prop.enum.includes(v)) return { ok: false, code: 'TOOL_ARG_ENUM', detail: `${k} 必须是 ${prop.enum.join('|')} 之一` };
    if (prop.type === 'string') {
      if (typeof v !== 'string') return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 string` };
      // D19（审计 3655d60）：长度按 Unicode 码点计（与 mariposa/Python 口径一致）——
      // 16 个 emoji 是 16 码点但 32 个 UTF-16 单位，按 v.length 会误拒服务端允许的标题
      const cpLen = [...v].length;
      if (prop.minLength !== undefined && cpLen < prop.minLength) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 至少 ${prop.minLength} 字` };
      if (prop.maxLength !== undefined && cpLen > prop.maxLength) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 超过 ${prop.maxLength} 字` };
    } else if (prop.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 integer` };
      if (propMinimumOf(prop) !== undefined && v < propMinimumOf(prop)!) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 最小值 ${propMinimumOf(prop)}` };
    } else if (prop.type === 'array') {
      if (!Array.isArray(v)) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 array` };
      if (prop.items?.type === 'string' && v.some((x) => typeof x !== 'string')) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 需要 string[]` };
      if (prop.items?.minLength !== undefined && v.some((x) => typeof x === 'string' && [...x].length < prop.items!.minLength!)) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 含空串条目（每条至少 ${prop.items.minLength} 字）` };
      if (prop.items?.enum && v.some((x) => !prop.items!.enum!.includes(x))) return { ok: false, code: 'TOOL_ARG_ENUM', detail: `${k} 含枚举外值（允许：${prop.items.enum.join('|')}）` };
      // 勾选式 object 条目（2026-10-18）：逐项核 required 整数字段 + 白名单外键拒绝
      if (prop.items?.type === 'object') {
        const itemProps = prop.items.properties ?? {};
        for (const item of v) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k} 条目需要 object` };
          for (const ik of Object.keys(item)) {
            if (!(ik in itemProps)) return { ok: false, code: 'TOOL_ARG_UNKNOWN', detail: `${k} 条目未知字段 ${ik}` };
          }
          for (const rq of prop.items.required ?? []) {
            if (item[rq as keyof typeof item] === undefined) return { ok: false, code: 'TOOL_ARG_REQUIRED', detail: `${k} 条目缺少 ${rq}` };
          }
          for (const [ik, ip] of Object.entries(itemProps)) {
            const iv = item[ik as keyof typeof item];
            if (iv === undefined) continue;
            if (ip.type === 'integer' && (typeof iv !== 'number' || !Number.isInteger(iv))) return { ok: false, code: 'TOOL_ARG_TYPE', detail: `${k}.${ik} 需要 integer` };
            if (ip.type === 'integer' && ip.minimum !== undefined && iv < ip.minimum) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k}.${ik} 最小值 ${ip.minimum}` };
          }
        }
      }
      if (prop.minItems !== undefined && v.length < prop.minItems) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 至少 ${prop.minItems} 条` };
      if (prop.maxItems !== undefined && v.length > prop.maxItems) return { ok: false, code: 'TOOL_ARG_LENGTH', detail: `${k} 超过 ${prop.maxItems} 条` };
    }
    out[k] = v;
  }
  for (const req of schema.required ?? []) {
    if (out[req] === undefined || (typeof out[req] === 'string' && (out[req] as string).length === 0)) return { ok: false, code: 'TOOL_ARG_REQUIRED', detail: `缺少必填 ${req}` };
  }
  return { ok: true, value: out };
}
