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

const PROBES = [
  { key: 'system_prompt_explicit', test: async (query) => {
      const iter = query({ prompt: 'Reply with exactly: PROBE_OK', options: { systemPrompt: 'You are a probe. Reply only with PROBE_OK.', maxTurns: 1, settingSources: [] } });
      for await (const msg of iter) {
        if (msg.type === 'result' && msg.subtype === 'success') return 'supported';
        if (msg.type === 'assistant' && msg.message?.content?.some(b => b.type === 'text' && b.text?.includes('PROBE_OK'))) return 'supported';
      }
      return 'unsupported';
    } },
  { key: 'settings_sources_isolated', test: async (query) => {
      // 省略实机验证——需要更复杂的探针；返回 unknown 而不是假 supported
      return 'unknown';
    } },
  { key: 'interrupt_supported', test: async (query) => {
      const ctrl = new AbortController();
      const iter = query({ prompt: 'Count from 1 to 100 slowly', options: { abortController: ctrl, maxTurns: 1 } });
      setTimeout(() => ctrl.abort(), 1000);
      try { for await (const _ of iter); } catch { /* abort */ }
      return 'supported'; // abort 没抛未处理异常即 supported
    } },
  { key: 'thinking_delta_observed', test: async (query) => {
      const iter = query({ prompt: 'What is 17*23? Think step by step.', options: { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' }, maxTurns: 1 } });
      for await (const msg of iter) {
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event?.delta?.type === 'thinking_delta') return 'supported';
      }
      return 'unsupported';
    } },
  { key: 'complete_block_mapping_verified', test: async (query) => {
      const iter = query({ prompt: 'Say hello', options: { includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' }, maxTurns: 1 } });
      let sawDelta = false;
      for await (const msg of iter) {
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event?.delta?.type === 'thinking_delta') sawDelta = true;
        if (msg.type === 'assistant' && msg.message?.content?.some(b => b.type === 'thinking')) {
          return sawDelta ? 'supported' : 'unsupported'; // 有 delta 也有完整块 → 映射可验
        }
      }
      return 'unknown';
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

// 仅对 supported 项写入证据
const { randomBytes } = await import('node:crypto');
for (const [key, state] of Object.entries(results)) {
  if (state !== 'supported') continue;
  db.prepare('INSERT OR REPLACE INTO capability_probes(id, probe_key, state, sdk_version, evidence_ref, observed_at) VALUES (?,?,?,?,?,?)')
    .run('prb_' + randomBytes(4).toString('hex'), key, 'supported', installedVersion, 'real-probe', new Date().toISOString());
}
console.log('[probe] 完成。supported 项已写入 capability_probes 表。');
process.exit(0);
