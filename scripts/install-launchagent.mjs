#!/usr/bin/env node
// 渲染 LaunchAgent（02 §2.3/T11）：默认 --dry-run 只打印；--apply 才写入
// ~/Library/LaunchAgents/online.charstarearth.estomago.plist。写入后需要用户手动
// launchctl 加载（本脚本不代加载、不开机自启之外的动作）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const apply = process.argv.includes('--apply');
const nodeBin = process.execPath;
const stateRoot = process.env.ESTOMAGO_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const logRoot = path.join(os.homedir(), 'Library', 'Logs', 'estomago');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'online.charstarearth.estomago.plist');

const template = fs.readFileSync(path.join(REPO, 'deploy/macos/online.charstarearth.estomago.plist.template'), 'utf8');
const rendered = template
  .replaceAll('__NODE_BIN__', nodeBin)
  .replaceAll('__PROJECT_ROOT__', REPO)
  .replaceAll('__STATE_ROOT__', stateRoot)
  .replaceAll('__LOG_ROOT__', logRoot)
  // RRA-020（2026-10-09 复审）：wrapper 式模板的 __HOME__ 占位此前
  // 无替换——渲染产物残留占位使 bash 找不到 wrapper（KeepAlive 反复失败）
  .replaceAll('__HOME__', os.homedir());

// RRA-020：渲染产物不得残留任何占位（dry-run 也校验）
const residual = rendered.match(/__[A-Z_]+__/g);
if (residual) {
  console.error(`[launchagent] 模板占位未全部替换：${[...new Set(residual)].join(', ')}`);
  process.exit(2);
}

if (apply) {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  if (fs.existsSync(plistPath) && !process.argv.includes('--force')) {
    console.error(`[launchagent] 已存在 ${plistPath}；覆盖需 --force`);
    process.exit(2);
  }
  fs.writeFileSync(plistPath, rendered);
  console.log(`[launchagent] 已写入 ${plistPath}`);
  console.log(`[launchagent] 手动加载（本脚本不代做）：`);
  console.log(`  launchctl bootstrap gui/$(id -u) ${plistPath}`);
  console.log(`[launchagent] 前置条件：$STATE_ROOT/config/estomago.yaml 已按现场核实填写。`);
} else {
  console.log(`[launchagent] dry-run（加 --apply 写入）。渲染结果：\n`);
  console.log(rendered);
}
