#!/usr/bin/env node
// 恢复到隔离目录（默认关闭副作用）：必须显式 --into <dir>；绝不直接覆盖在用数据库。
// 恢复验证完成后才允许人工切换（18.2）。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fileIdx = args.findIndex((a) => !a.startsWith('--'));
const intoIdx = args.indexOf('--into');
if (fileIdx < 0 || intoIdx < 0 || !args[intoIdx + 1]) {
  console.error('用法: node scripts/restore.mjs <backup.sqlite3> --into <隔离目录>');
  console.error('说明: 恢复区只用于验证；切换正式库需人工确认，本脚本不做。');
  process.exit(2);
}
const src = path.resolve(args[fileIdx]);
const destDir = path.resolve(args[intoIdx + 1]);
if (!fs.existsSync(src)) {
  console.error(`[restore] 备份不存在：${src}`);
  process.exit(1);
}
const prodLike = `${path.join(process.env.HOME ?? '', 'Library', 'Application Support')}/estomago`;
if (path.resolve(destDir) === path.resolve(prodLike)) {
  console.error('[restore] 拒绝：--into 指向生产状态根；恢复必须先到隔离目录验证。');
  process.exit(2);
}
fs.mkdirSync(path.join(destDir, 'data'), { recursive: true });
const dest = path.join(destDir, 'data', 'chat.sqlite3');
fs.copyFileSync(src, dest);
console.log(`[restore] 已恢复到隔离目录：${dest}`);
console.log('[restore] 副作用默认关闭：验证时不要配置推送/归档/模型凭据。');
