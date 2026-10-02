#!/usr/bin/env node
// 能力探针（AUD-02 配套）：唯一允许向 capability_probes 写"supported"证据的生产入口。
// 纪律：真实探测会发起真实 Claude Agent SDK 调用——必须由用户显式授权
//（ESTOMAGO_REAL_PROBE=1 由用户本人设置；且遵守"Claude 相关行为须二次确认"）。
// 未授权时：只读自检 + 打印 BLOCKED，不写任何证据行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const authorized = process.env.ESTOMAGO_REAL_PROBE === '1';
let sdk = null;
let db = null;
const root = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const dbFile = path.join(root, 'data/chat.sqlite3');

console.log(`[probe] stateRoot=${root}`);
console.log(`[probe] 授权状态：${authorized ? '已授权（ESTOMAGO_REAL_PROBE=1）' : '未授权 → 仅自检，不写证据'}`);
if (!fs.existsSync(dbFile)) {
  console.log('[probe] BLOCKED：数据库不存在（先完成首次启动）');
  process.exit(2);
}
if (!authorized) {
  console.log('[probe] BLOCKED：真实 SDK 探测需用户显式授权（设 ESTOMAGO_REAL_PROBE=1 并确认认证方式）。');
  console.log('[probe] 依据：Claude 相关行为须二次确认的用户规则；未获确认前 gate 维持 IDENTITY_BLOCKED。');
  process.exit(2);
}
// 授权后加载 SDK 和数据库
sdk = (await import('@anthropic-ai/claude-agent-sdk'));
db = new DatabaseSync(dbFile);
// F05：授权路径——逐项运行最小 SDK 探测，仅对实测 supported 项写证据
// 每个探针是一次有界真实调用（会消耗少量 token）；运行前须确认认证已配置
const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const installedVersion = (() => {
  try {
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
    const fs2 = require_('node:fs');
    const path2 = require_('node:path');
    return JSON.parse(fs2.readFileSync(path2.join(path2.dirname(entry), 'package.json'), 'utf8')).version;
  } catch { return null; }
})();
if (!installedVersion) { console.error('[probe] BLOCKED：SDK 未安装'); process.exit(2); }

// F05：共享探针骨架——认证/服务错误返回 'blocked'（不是能力否定，也不是 supported）；
// 判定函数返回 'supported' | 'unsupported' | 'unknown' | null（null=继续迭代）。
const isAuthOrServerError = (msg) => /api key|unauthorized|authentication|forbidden|quota|billing|overloaded|rate.?limit/i.test(msg);
// 'aborted' 在非 interrupt 探针属意外中断 → blocked；null → unsupported
const mapVerdict = (v) => (v === 'aborted' ? 'blocked' : v ?? 'unsupported');
async function runProbe(iterFactory, judge) {
  let carried = null; // 认证/服务错误信息（result error 或迭代异常）
  try {
    for await (const msg of iterFactory()) {
      if (msg.type === 'result' && msg.is_error === true) {
        carried = msg.error ?? `result subtype=${msg.subtype}`;
        if (isAuthOrServerError(String(carried))) return 'blocked';
        continue; // 非认证类 error result 交给 judge（探针可能自带预期失败语义）
      }
      const verdict = judge(msg);
      if (verdict !== null) return verdict;
    }
  } catch (err) {
    const msgText = String(err?.message ?? err);
    if (/abort|interrupt/i.test(msgText)) return 'aborted'; // 正常的 abort 终止路径，由调用方按 signal 判定
    if (isAuthOrServerError(msgText)) return 'blocked';
    throw err; // 意外异常按 blocked 处理（外层 catch）
  }
  if (carried) return 'blocked'; // 以 error result 结束且无能力证据
  return null;
}

const PROBES = [
  { key: 'system_prompt_explicit', test: async (query) => {
      // F05：必须看到正文含 PROBE_OK 才算 systemPrompt 生效；仅 result success 不构成证据
      const verdict = await runProbe(
        () => query({ prompt: 'Reply with exactly: PROBE_OK', options: { systemPrompt: 'You are a probe. Reply only with PROBE_OK.', maxTurns: 1, settingSources: [] } }),
        (msg) => {
          if (msg.type === 'assistant' && msg.message?.content?.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('PROBE_OK'))) return 'supported';
          return null;
        },
      );
      return mapVerdict(verdict);
    } },
  { key: 'settings_sources_isolated', test: async () => {
      // F05：无可靠断言路径——恒 unknown（诚实状态），由写库覆盖旧 supported（见写库逻辑）
      return 'unknown';
    } },
  { key: 'interrupt_supported', test: async (query) => {
      // F05：需要 SDK 真正在跑（观察到流事件）且 abort 被接受（signal.aborted）才 supported；
      // 认证失败（第一个消息就是 error result / 抛错）由 runProbe 判 blocked，不再无条件 supported
      const ctrl = new AbortController();
      let sawActivity = false;
      const verdict = await runProbe(
        () => {
          const iter = query({ prompt: 'Count from 1 to 100 slowly', options: { abortController: ctrl, maxTurns: 1 } });
          setTimeout(() => ctrl.abort(), 1000);
          return iter;
        },
        (msg) => {
          if (msg.type === 'stream_event' || msg.type === 'assistant' || msg.type === 'message_start') sawActivity = true;
          return null;
        },
      );
      if (verdict === 'blocked' || verdict === 'supported') return verdict;
      return ctrl.signal.aborted && sawActivity ? 'supported' : 'unsupported';
    } },
  { key: 'thinking_delta_observed', test: async (query) => {
      const verdict = await runProbe(
        () => query({ prompt: 'What is 17*23? Think step by step.', options: { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' }, maxTurns: 1 } }),
        (msg) => {
          if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event?.delta?.type === 'thinking_delta') return 'supported';
          return null;
        },
      );
      return mapVerdict(verdict);
    } },
  { key: 'complete_block_mapping_verified', test: async (query) => {
      // F05：delta 与完整 thinking 块必须属于同一 SDK message id 才算映射可验
      let deltaMessageId = null;
      let currentMessageId = null;
      const verdict = await runProbe(
        () => query({ prompt: 'Say hello', options: { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' }, maxTurns: 1 } }),
        (msg) => {
          if (msg.type === 'stream_event' && msg.event?.type === 'message_start') currentMessageId = msg.event?.message?.id ?? currentMessageId;
          if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event?.delta?.type === 'thinking_delta') deltaMessageId = currentMessageId;
          if (msg.type === 'assistant' && msg.message?.content?.some((b) => b.type === 'thinking')) {
            if (deltaMessageId && (msg.message.id ?? deltaMessageId) === deltaMessageId) return 'supported';
            return 'unsupported'; // delta 与完整块不同消息——映射未获证据
          }
          return null;
        },
      );
      return mapVerdict(verdict) === 'unsupported' ? 'unknown' : mapVerdict(verdict);
    } },
];

const results = {};
for (const probe of PROBES) {
  try {
    console.log(`[probe] 运行 ${probe.key} …`);
    const state = await probe.test(sdk.query);
    results[probe.key] = state;
    console.log(`[probe] ${probe.key}: ${state}`);
  } catch (err) {
    results[probe.key] = 'blocked';
    console.log(`[probe] ${probe.key}: blocked (${String(err.message).slice(0, 60)})`);
  }
}

// F05：所有结果如实写库（INSERT OR REPLACE 覆盖同 (key, sdk_version) 旧行）——
// 失败/unknown 作废旧 supported 证据，gate 只认 supported，不会因残留行误放行
const { randomBytes } = await import('node:crypto');
for (const [key, state] of Object.entries(results)) {
  db.prepare('INSERT OR REPLACE INTO capability_probes(id, probe_key, state, sdk_version, evidence_ref, observed_at) VALUES (?,?,?,?,?,?)')
    .run('prb_' + randomBytes(4).toString('hex'), key, state, installedVersion, 'real-probe', new Date().toISOString());
}
console.log('[probe] 完成。全部结果（含 unsupported/unknown/blocked）已如实写入 capability_probes 表。');
process.exit(0);
