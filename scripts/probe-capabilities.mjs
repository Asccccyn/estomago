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
// 授权路径（待用户批准认证后实现/执行）：逐项运行最小 SDK 探测并仅对实测 supported 项写证据
console.log('[probe] 授权路径待执行：请在获得用户批准的认证环境下运行各探针后写入。');
process.exit(0);
