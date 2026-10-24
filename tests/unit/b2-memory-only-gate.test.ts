// B2/A04（2026-10-24）：通话 memory_only 能力策略——catalog/define/invoke/直接执行/执行前
// 边界同一策略；模型发起被限（UI/宿主内部调用不受限）；挂断后恢复；旧窗冻结目录不变。
import { test } from 'node:test';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HostToolExecutor, type ToolExecContext } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { freezeWindowTools, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { buildHostTools } from '../../apps/host/src/runtime/host-tools.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-memonly-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('c1');
  const tools = new HostToolExecutor({ db, media, messages, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), oido: null as never })
  wireOidoCapabilitiesForTest(tools, {});;
  const ctx = (over: Partial<ToolExecContext> = {}): ToolExecContext => ({ roomId: 'c1', windowId: 'w1', turnId: 'turn-model-1', purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'b2m', ...over });
  // deferred 冻结窗：含记忆工具与业务工具
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('w1','c1','ACTIVE','2026-10-24','2026-10-24')").run();
  freezeWindowTools(db, 'w1', buildHostTools(), 'deferred');
  const startCall = (callId = 'call-m1'): void => {
    db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)").run(callId, 'c1', new Date().toISOString());
  };
  const endCall = (callId = 'call-m1'): void => {
    db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=?").run(new Date().toISOString(), callId);
  };
  return { root, db, tools, ctx, startCall, endCall, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('A04 catalog during call lists only memory and control tools', async () => {
  const f = fixture();
  try {
    const before = await f.tools.execute('tool_catalog', { __tool_call_id: 'tc0' }, f.ctx());
    assert.equal(before.ok, true);
    const beforeNames = ((before.output as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    assert.ok(beforeNames.includes('wishstar_list_offers'), '非通话目录含业务工具（冻结目录本身不变）');
    f.startCall();
    const during = await f.tools.execute('tool_catalog', { __tool_call_id: 'tc1' }, f.ctx());
    assert.equal(during.ok, true);
    const duringNames = ((during.output as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    assert.ok(!duringNames.includes('wishstar_list_offers'), '通话内新 catalog 不列非记忆业务工具');
    assert.ok(!duringNames.includes('oido_find'), '重型 oído find 不在通话热路径');
    for (const n of duringNames) assert.ok(HostToolExecutor.MEMORY_ONLY_TOOLS.has(n), `目录项 ${n} 必须在许可表`);
    console.log(JSON.stringify({ case: 'a04_catalog', before: beforeNames.length, during: duringNames.length }));
  } finally { f.close(); }
});

test('A04 define/invoke/direct execution all gated during call; recovery after hangup; UI path unaffected', async () => {
  const f = fixture();
  try {
    f.startCall();
    const ctx = f.ctx();
    // define 非记忆工具：define 本身可过（延迟发现机制），但定义后 invoke 被拒；直接执行同样被拒
    const def = await f.tools.execute('tool_define', { name: 'wishstar_list_offers', __tool_call_id: 'td1' }, ctx);
    assert.equal(def.ok, true); // 目录机制开放；执行边界才是能力门
    const inv = await f.tools.execute('tool_invoke', { name: 'wishstar_list_offers', definition_id: (def.output as { definition_id: string }).definition_id, arguments: {}, __tool_call_id: 'ti1' }, ctx);
    assert.equal(inv.ok, false);
    assert.equal((inv.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL');
    const direct = await f.tools.execute('media_search', { query: 'x' }, ctx);
    assert.equal(direct.ok, false);
    assert.equal((direct.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL');
    // UI/宿主内部调用（无 turnId）不受限：media_search 未配置时返回能力缺口而非策略拒绝
    const ui = await f.tools.execute('media_search', { query: 'x' }, f.ctx({ turnId: null }));
    assert.notEqual((ui.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL');
    // 挂断后恢复普通策略（冻结目录仍含业务工具）
    f.endCall();
    const after = await f.tools.execute('media_search', { query: 'x' }, f.ctx());
    assert.notEqual((after.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL', '挂断后恢复');
    // 记忆读取在通话内保留
    f.startCall('call-m2');
    const mem = await f.tools.execute('conversation_read', { limit: 5 }, f.ctx());
    assert.notEqual((mem.output as { error_code: string }).error_code, 'TOOL_UNAVAILABLE_IN_CALL', '记忆读取不受限');
    console.log(JSON.stringify({ case: 'a04_gate', invoke: (inv.output as { error_code: string }).error_code, direct: (direct.output as { error_code: string }).error_code }));
  } finally { f.close(); }
});
