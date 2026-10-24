// 她 1022 指令：初始可读工具（首批=identity_milestone_write，原本整版 write 与新增
// 条目化一起）——定义随 B 段注入；新窗直接 invoke 免 define 三跳；旧窗零回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRoot, makePaths, writeApprovedIdentity, makeDb, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { buildDeferredTools, definitionId, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';
import { initialVisibleTools, renderInitialVisibleText, initialDefinitionSeen, DEFAULT_INITIAL_VISIBLE } from '../../apps/host/src/runtime/tool-initial-visible.ts';
import { buildHostTools } from '../../apps/host/src/runtime/host-tools.ts';

function setupDb() {
  const root = tempRoot('tiv-');
  const { db } = makeDb(root);
  return { db, root };
}

test('清单与渲染：默认=她 1022 首批（里程碑整版+条目化一起）；文本含 definition_id 与完整参数', () => {
  const { db } = setupDb();
  assert.deepEqual(initialVisibleTools(db), [...DEFAULT_INITIAL_VISIBLE]);
  assert.deepEqual(DEFAULT_INITIAL_VISIBLE, ['identity_milestone_write']);
  const text = renderInitialVisibleText(db, buildHostTools())!;
  assert.ok(text.includes('[tools/initial'), '段落头');
  const spec = { type: 'function', function: buildDeferredTools()[0]!.function } as never;
  void spec;
  // 里程碑工具定义同源（host-tools buildHostTools）——文本含其两种用法描述
  assert.ok(text.includes('identity_milestone_write'));
  assert.ok(text.includes('definition_id:'));
  assert.ok(text.includes('operation'), '条目化用法在描述里');
  assert.ok(text.includes('write'), '原本整版用法在描述里');
  // runtime_settings 覆盖（她可改清单）
  db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES ('tools_initial_visible', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(['memory_i_write']), new Date().toISOString());
  assert.deepEqual(initialVisibleTools(db), ['memory_i_write']);
  // 空清单=不注入
  db.prepare("UPDATE runtime_settings SET value = '[]' WHERE key = 'tools_initial_visible'").run();
  assert.equal(renderInitialVisibleText(db, buildHostTools()), null);
});

test('invoke 旁路：初始工具的定义随窗请求真实发出→免 define 直接 invoke；旧窗（无注入）仍走旧门', async () => {
  const root = tempRoot('tiv-invoke-');
  writeApprovedIdentity(root, { seedProbes: false });
  const paths = makePaths(root);
  const { db } = makeDb(root);
  const svc = new IdentityService(buildConfig({}), paths);
  // 里程碑夹具（工具会真实执行 read）
  fs.writeFileSync(path.join(paths.identityDir, 'longterm-milestones-v1.md'), '条目一\n\n条目二', { mode: 0o600 });
  const mp = path.join(paths.configDir, 'identity-manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8')) as Record<string, unknown>;
  m.approved_source_ref = 'longterm-milestones-v1.md'; m.identity_version = 'longterm-milestones-v1'; m.approved_source_hash = sha256Hex('条目一\n\n条目二');
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), identity: svc })
  wireOidoCapabilitiesForTest(tools, {});;

  // 新窗：冻结 deferred 工具集 + 首个"已发送"请求携带 B 段注入文本（含 definition_id）
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('c1','estomago','private',?)").run(new Date().toISOString());
  const winNew = 'win-tiv-new';
  db.prepare("INSERT OR IGNORE INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,'c1','ACTIVE',?,?)").run(winNew, new Date().toISOString(), new Date().toISOString());
  const realSpec = (await import('../../apps/host/src/runtime/host-tools.ts')).buildHostTools().find((t) => t.function.name === 'identity_milestone_write')!;
  const catalog = [realSpec];
  db.prepare('INSERT INTO window_toolsets(window_id, protocol, wire_tools_json, catalog_json, created_at) VALUES (?,?,?,?,?)')
    .run(winNew, 'deferred', JSON.stringify(buildDeferredTools()), JSON.stringify(catalog), new Date().toISOString());
  const milestoneSpec = (await import('../../apps/host/src/runtime/host-tools.ts')).buildHostTools().find((t) => t.function.name === 'identity_milestone_write')!;
  const injected = renderInitialVisibleText(db, buildHostTools())!;
  assert.ok(injected.includes(definitionId(milestoneSpec)), '注入文本含真实 definition_id');
  const fakeRequest = JSON.stringify({ messages: [{ role: 'system', content: [{ type: 'text', text: injected }] }] });
  db.prepare("INSERT INTO turns(id, conversation_id, trigger, state, created_at) VALUES ('turn-tiv','c1','user_message','completed',?)").run(new Date().toISOString());
  db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, state, window_id) VALUES ('att-tiv','turn-tiv',1,'completed',?)").run(winNew);
  db.prepare("INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('prq-tiv-1', winNew, 'att-tiv', 'turn-tiv', 'chat', '[]', fakeRequest, new Date().toISOString(), new Date().toISOString());
  assert.equal(initialDefinitionSeen(db, winNew, milestoneSpec), true, '定义已真实进入已发送请求=已见');

  const ctxNew = { roomId: 'c1', windowId: winNew, turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'r1' };
  const direct = await tools.execute('tool_invoke', {
    __tool_call_id: 'c1', name: 'identity_milestone_write', definition_id: definitionId(milestoneSpec),
    arguments: { operation: 'read' },
  }, ctxNew);
  assert.equal(direct.ok, true, '新窗直接 invoke 成功（免 define 三跳）');
  assert.ok(String(JSON.stringify(direct.output)).includes('条目一'), 'read 真实执行');

  // 旧窗：工具集在但从未发送过注入文本 → 旁路不成立 → 仍拒绝（零回退）
  const winOld = 'win-tiv-old';
  db.prepare("INSERT OR IGNORE INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,'c1','ACTIVE',?,?)").run(winOld, new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO window_toolsets(window_id, protocol, wire_tools_json, catalog_json, created_at) VALUES (?,?,?,?,?)')
    .run(winOld, 'deferred', JSON.stringify(buildDeferredTools()), JSON.stringify(catalog), new Date().toISOString());
  void realSpec;
  const ctxOld = { ...ctxNew, windowId: winOld };
  const refused = await tools.execute('tool_invoke', {
    __tool_call_id: 'c2', name: 'identity_milestone_write', definition_id: definitionId(milestoneSpec),
    arguments: { operation: 'read' },
  }, ctxOld);
  assert.equal(refused.ok, false, '旧窗无注入=仍走 catalog→define 旧门');
  assert.equal((refused.output as { error_code: string }).error_code, 'TOOL_DEFINITION_NOT_SEEN');
  db.close();
});

// R1′（2026-10-23，D2 裁定）：空工具清单回归——显式配置空数组=如实无 tools/initial 段
// （renderInitialVisibleText 返回 null），空资料窗不带占位 B；B 是否携带仅由清单决定
test('空工具清单：显式配置 [] → 无 tools/initial 段（renderInitialVisibleText=null）', async () => {
  const { makeDb } = await import('../helpers.ts');
  const { db } = makeDb(tempRoot('tiv-empty-'), { seed: false });
  db.prepare("INSERT INTO runtime_settings(key, value, updated_at) VALUES ('tools_initial_visible','[]','2026-10-23T00:00:00Z')").run();
  assert.equal(renderInitialVisibleText(db, buildHostTools()), null, '空清单=无注入');
  db.close();
});
