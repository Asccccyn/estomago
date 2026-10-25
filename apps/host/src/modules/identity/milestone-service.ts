// modules/identity/milestone-service.ts（P04.8）：identity_milestone_write 用例（与 Mariposa I 分开）。
// 原 HostToolExecutor 方法逐字迁移：原版本与条目化语义保持；幂等键查 audit_events；
// I 槽不参与指纹——当前窗继续旧冻结副本，下一新窗自动带新版。
import type { Db } from '../../db/connection.ts';
import type { IdentityService } from '../../identity/service.ts';
import { IdentityService as IdentityServiceStatic } from '../../identity/service.ts';
import { sha256Hex } from '../../util/id.ts';
import type { ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

export class IdentityMilestoneService {
  private readonly db: Db;
  private readonly identity: IdentityService | null;

  constructor(deps: { db: Db; identity?: IdentityService | null }) {
    this.db = deps.db;
    this.identity = deps.identity ?? null;
  }

  identityMilestoneWrite(args: { operation?: string; text?: string; item?: number; change_reason?: string; idempotency_key?: string }, ctx: ToolExecContext): ToolExecResult {
    if (!this.identity) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '身份服务未装配' } };
    const op = args.operation === 'read' || args.operation === 'add' || args.operation === 'revise' || args.operation === 'remove' ? args.operation : 'write';
    if (op === 'read') {
      try {
        const r = this.identity.readMilestone();
        const entries = IdentityServiceStatic.entryLines(r.text);
        // 1.2.3.4. 连续条号（=revise/remove 的 item 口径）；原文物理行号不外显
        return { ok: true, output: { version: r.version, entries: entries.length, text: entries.map((e, i) => `${i + 1}. ${e.line}`).join('\n') } };
      } catch (err) {
        return { ok: false, output: { error_code: 'MILESTONE_READ_FAILED', detail: String((err as Error).message).slice(0, 200) } };
      }
    }
    // 写类操作：change_reason/idempotency_key 必填；text 按 op 分（write/add/revise 必带，remove 不带）
    const needText = op === 'write' || op === 'add' || op === 'revise';
    if (typeof args.change_reason !== 'string' || args.change_reason.length === 0 || typeof args.idempotency_key !== 'string' || args.idempotency_key.length === 0) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: '写操作必须带 change_reason 与 idempotency_key' } };
    }
    if (needText && (typeof args.text !== 'string' || args.text.length === 0)) {
      return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', detail: `${op} 必须带 text` } };
    }
    const idemKey = `milestone:${ctx.turnId ?? 'noturn'}:${ctx.requestId}:${args.idempotency_key}`;
    const prior = this.db.prepare("SELECT scope, result FROM audit_events WHERE who = 'jiaming' AND what = 'identity_milestone_write' AND detail_ref = ? ORDER BY created_at DESC LIMIT 1").get(idemKey) as { scope: string | null; result: string } | undefined;
    if (prior) return { ok: true, output: { saved: true, version: prior.scope ?? null, duplicate: true } };
    let written: { file: string; version: string; hash: string; byteSize: number; entries?: number };
    try {
      if (op === 'write') {
        written = this.identity.updateMilestone(args.text!);
      } else {
        const r = this.identity.applyMilestoneEntryOp(op, op === 'add' ? null : (typeof args.item === 'number' ? args.item : 0), op === 'remove' ? null : args.text ?? null);
        written = { file: r.file, version: r.version, hash: r.hash, byteSize: r.byteSize, entries: r.entries };
      }
    } catch (err) {
      return { ok: false, output: { error_code: 'MILESTONE_WRITE_FAILED', detail: String((err as Error).message).slice(0, 200) } };
    }
    this.db.prepare('INSERT INTO audit_events(id, who, what, scope, result, detail_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `aud_${sha256Hex(idemKey + written.version).slice(0, 24)}`, 'jiaming', 'identity_milestone_write', written.version, `ok:${op}:${written.byteSize}B:${args.change_reason.slice(0, 200)}`, idemKey, new Date().toISOString(),
    );
    return { ok: true, output: { saved: true, operation: op, version: written.version, file: written.file, byte_size: written.byteSize, ...(written.entries !== undefined ? { entries: written.entries } : {}), effective: 'next_window', note: '当前窗继续旧版；下一扇新窗自动带新版' } };
  }

}
