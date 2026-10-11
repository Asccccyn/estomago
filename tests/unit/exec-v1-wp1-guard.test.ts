// EXEC_V1 §05.9（TOKEN-04）：预估回包应用守卫（composer-logic 纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyEstimate } from '../../apps/web/src/composer-logic.js';

const resp = (over = {}) => ({ client_draft_revision: 5, model_snapshot_id: 'ms-1', attachment_fingerprint: null, ...over });

test('TOKEN-04：只应用同时匹配 draft_revision/模型快照/附件指纹的回包；过期响应丢弃', () => {
  const cur = { draftRevision: 5, modelSnapshotId: 'ms-1', attachmentFingerprint: null };
  assert.equal(shouldApplyEstimate(resp(), cur), true);
  // 草稿已更新（打了新字）→ 旧回包丢弃
  assert.equal(shouldApplyEstimate(resp(), { ...cur, draftRevision: 6 }), false);
  // 换模型（快照变化）→ 旧回包丢弃
  assert.equal(shouldApplyEstimate(resp(), { ...cur, modelSnapshotId: 'ms-2' }), false);
  // 附件指纹变化（加图/换图）→ 旧回包丢弃
  assert.equal(shouldApplyEstimate(resp({ attachment_fingerprint: 'fp-a' }), { ...cur, attachmentFingerprint: 'fp-a' }), true);
  assert.equal(shouldApplyEstimate(resp({ attachment_fingerprint: 'fp-a' }), { ...cur, attachmentFingerprint: 'fp-b' }), false);
  // null 附件指纹两侧一致才通过
  assert.equal(shouldApplyEstimate(resp({ attachment_fingerprint: 'fp-a' }), cur), false);
  // 空回包/缺字段不炸
  assert.equal(shouldApplyEstimate(null, cur), false);
  assert.equal(shouldApplyEstimate({ client_draft_revision: 5 }, cur), false);
});
