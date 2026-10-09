#!/usr/bin/env node
// WP-05（C04）：wp7 系 fixture 再生成脚本——devseed 合成数据 → M 真
// registry.invoke（start/page）→ dump 为 fixture。fixture 头锚定 M
// commit（生成时记录），漂移即重跑本脚本对齐。
// 用法：MARIPOSA_ROOT=<隔离根> node scripts/gen-wp7-fixture.mjs [--m-repo <path>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const M = process.argv.includes('--m-repo')
  ? process.argv[process.argv.indexOf('--m-repo') + 1]
  : path.join(process.env.HOME ?? '', 'Projects', 'mariposa');
const fixtureDir = path.join(import.meta.dirname, '../tests/fixtures/mariposa');
fs.mkdirSync(fixtureDir, { recursive: true });

const mCommit = execFileSync('git', ['-C', M, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const stamp = new Date().toISOString();
const header = `// 由 scripts/gen-wp7-fixture.mjs 生成——锚定 M commit ${mCommit.slice(0, 12)}（${stamp}）\n`;

const probe = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(M, 'backend'))})
import os
os.environ.setdefault('MARIPOSA_ALLOW_CREATE', '1')
from mariposa import schema
schema.migrate(); schema.migrate_runtime()
from mariposa.identity import service as identity
from mariposa.memory import service as memory
from mariposa.recall import judge_policy, service as rs
jm = identity.Principal('jiaming', 'j', 'agent', 'claude_chat', 'bj')
for i in range(12):
    memory.hold(jm, text=f'wp7夹具南瓜灯事件{i:02d}', memory_date='2026-09-01',
                date_confidence='exact', original_title=f'w{i}', categories=['daily'],
                creation_mode='contemporaneous', raw_pending=False)
pol = judge_policy.get_policy()
judge_policy.update_policy('qiaosheng', expected_revision=pol['revision'], enabled=False,
                           provider=None, idempotency_key='gen-wp7')
p1 = rs.start(jm, {'query_plan': {'original_request': '南瓜灯', 'channels': ['event'],
                                   'lexical_terms': ['南瓜灯'], 'request_ref': 'gen-wp7-r1'}},
              op_ctx={'principal_id': 'jiaming', 'operation_key': 'start:new:gen-wp7',
                      'payload_hash': 'gen-wp7'})
print(json.dumps(p1, ensure_ascii=False, default=str))
`;
const out = execFileSync(path.join(M, '.venv/bin/python'), ['-c', probe], {
  encoding: 'utf8', env: { ...process.env, MARIPOSA_ROOT: process.env.MARIPOSA_ROOT || '/tmp/gen-wp7-root' },
});
fs.writeFileSync(path.join(fixtureDir, 'wp7-recall-off-first-page.body.json'),
  header + JSON.stringify({ ok: true, data: JSON.parse(out) }, null, 2));
console.log(`[gen-wp7] fixture 写入（M commit ${mCommit.slice(0, 12)}）`);
