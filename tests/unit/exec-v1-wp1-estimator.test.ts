// ESTOMAGO_CHAT_EXEC_V1 · WP1 estimator 与 ALERT-01 分类门（05 §2.2/§7/§8；TOKEN-01/02/07 + ALERT-01）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, snapshotFor, visibleTextRoughTokens, ESTIMATOR_REVISION } from '../../apps/host/src/usage/estimator.ts';
import { evaluateCacheMiss } from '../../apps/host/src/observability/system-alerts.ts';

const BASE = { model: 'anthropic/claude-sonnet-4.5', charsPerToken: 2.5, content: '', attachments: [], outputCapTokens: 8192 };

test('TOKEN-01：混合文字粗估用 Unicode 码点统一口径；rough 标签可见不称精确；多行正文是一条消息', () => {
  const zh = '你好世界'; // 4 码点
  const e1 = estimateTokens({ ...BASE, content: zh });
  assert.equal(e1.message_text_tokens, Math.ceil(4 / 2.5)); // 码点口径，不是 UTF-16 字节
  assert.equal(e1.quality, 'rough_text');
  assert.equal(e1.estimator_revision, ESTIMATOR_REVISION);
  // emoji（astral 平面）：UTF-16 会算 2，码点算 1
  const emoji = '👍'.repeat(10);
  const e2 = estimateTokens({ ...BASE, content: emoji });
  assert.equal(e2.message_text_tokens, Math.ceil(10 / 2.5));
  // ASCII + 中文 + emoji + 代码块混合：同一函数同一系数
  const mixed = `def f():\n    return "ok"\n你好 ${'👍'.repeat(3)}`;
  const cp = [...mixed].length;
  assert.equal(estimateTokens({ ...BASE, content: mixed }).message_text_tokens, Math.ceil(cp / 2.5));
  // 多行换行不拆消息（输入语义硬约束在服务端；估计器对含 \n 的正文整体计一次）
  assert.equal(estimateTokens({ ...BASE, content: 'a\nb\nc' }).message_text_tokens, Math.ceil(3 / 2.5));
  // 系数版本化：不同系数不同结果，都可复算
  assert.equal(estimateTokens({ ...BASE, content: zh, charsPerToken: 1.5 }).message_text_tokens, Math.ceil(4 / 1.5));
});

test('TOKEN-02：本条 ≠ 完整请求；回复上限不叫必然输出；请求不可用时本条估计照给', () => {
  const msg = estimateTokens({ ...BASE, content: '这一条消息', requestProjection: null });
  assert.equal(msg.scope, 'message_only');
  assert.equal(msg.request_input_tokens, null);
  // 无活动窗（等待人工选集）：request 标 pending_selection，message 照给
  const pend = estimateTokens({ ...BASE, content: '这一条消息', requestProjection: { tokens: null, unavailable_reason: 'pending_selection' } });
  assert.equal(pend.request_input_tokens, null);
  assert.equal(pend.request_unavailable_reason, 'pending_selection');
  assert.ok(pend.message_text_tokens > 0);
  // 完整请求投影 > 本条正文；输出上限只是上限
  const full = estimateTokens({ ...BASE, content: '这一条消息', requestProjection: { tokens: 5000, window_id: 'w1', window_revision: 3 } });
  assert.ok(full.request_input_tokens! > full.message_text_tokens);
  assert.equal(full.scope, 'request_preview');
  assert.equal(full.output_cap_tokens, 8192); // 上限字段原样，不冒充预计生成量
});

test('TOKEN-07：未知图片 partial（不按 base64 长度估）；音频转写不双计；已知小计保留', () => {
  const img = estimateTokens({ ...BASE, content: '看这张图', attachments: [{ kind: 'image', fingerprint: 'fp-1', bytes: 4 * 1024 * 1024 }] });
  assert.equal(img.message_media_tokens, null); // 未知就是未知
  assert.equal(img.message_total_tokens, null); // 有未知组成 → 总量 null，不伪称精确
  assert.equal(img.message_known_subtotal, img.message_text_tokens); // 已知小计保留
  assert.equal(img.quality, 'partial_media');
  assert.ok(img.unknown_components.includes('image_tokens_unknown'));
  // 图片带已核 known_tokens → 计入；文字小计不受影响
  const imgKnown = estimateTokens({ ...BASE, content: '看这张图', attachments: [{ kind: 'image', fingerprint: 'fp-1', known_tokens: 1200 }] });
  assert.equal(imgKnown.message_media_tokens, 1200);
  assert.equal(imgKnown.message_total_tokens, imgKnown.message_text_tokens + 1200);
  // 音频：转写文字未进入模型输入 → 不加"音频 token"（费用单列外部服务）
  const aud = estimateTokens({ ...BASE, content: '听这段', attachments: [{ kind: 'audio', fingerprint: 'fp-2', bytes: 1024 * 1024 }] });
  assert.equal(aud.message_media_tokens, null);
  assert.ok(aud.unknown_components.includes('audio_transcript_not_in_model_input'));
  // code_artifact 是文本：按字节粗估，仍标 rough
  const code = estimateTokens({ ...BASE, content: '作品', attachments: [{ kind: 'code_artifact', fingerprint: 'fp-3', bytes: 500 }] });
  assert.ok(code.message_media_tokens! >= Math.ceil(500 / 2.5) - 1);
  // 快照不含请求维度
  const snap = snapshotFor({ ...BASE, content: 'hi' }, '2026-10-11T00:00:00.000Z');
  assert.equal(snap.computed_at, '2026-10-11T00:00:00.000Z');
  assert.ok(!('request_input_tokens' in snap));
  // 助手气泡本地粗估
  assert.equal(visibleTextRoughTokens('abcde', 2.5), 2);
});

test('ALERT-01：温缓存未命中五条件门——冷启动/字段缺失/部分命中/换模型都不触发；全齐备 read=0 才触发', () => {
  const warm = { cache_read_tokens: 0, same_model_and_upstream: true, same_cacheable_prefix_version: true, has_prior_reliable_read_write: true, within_expected_ttl: true, known_cold_start: false, prefix_at_least_min_cacheable: true };
  assert.deepEqual(evaluateCacheMiss(warm), { trigger: true, reason: 'warm_cache_expected_read_zero' });
  // 正常冷启动/新窗/受控换窗/媒体重新物化：不触发
  assert.equal(evaluateCacheMiss({ ...warm, known_cold_start: true }).trigger, false);
  // 供应商没提供 cache 字段：unknown，不当 0 也不当命中
  assert.deepEqual(evaluateCacheMiss({ ...warm, cache_read_tokens: null }), { trigger: false, reason: 'cache_fields_missing_unknown' });
  // read>0：部分命中，不称全命中也不报 miss
  assert.deepEqual(evaluateCacheMiss({ ...warm, cache_read_tokens: 800 }), { trigger: false, reason: 'partial_or_full_hit' });
  // 换模型/上游变化
  assert.equal(evaluateCacheMiss({ ...warm, same_model_and_upstream: false }).trigger, false);
  // 前缀版本变化（受控换窗等已知变化）
  assert.equal(evaluateCacheMiss({ ...warm, same_cacheable_prefix_version: false }).trigger, false);
  // 超过预计 TTL
  assert.equal(evaluateCacheMiss({ ...warm, within_expected_ttl: false }).trigger, false);
  // 无上次可靠读写证据
  assert.equal(evaluateCacheMiss({ ...warm, has_prior_reliable_read_write: false }).trigger, false);
  // 提示不足最小可缓存长度
  assert.equal(evaluateCacheMiss({ ...warm, prefix_at_least_min_cacheable: false }).trigger, false);
});
