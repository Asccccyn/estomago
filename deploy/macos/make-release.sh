#!/bin/bash
# estómago release 检出制造脚本——2026-11-08 立此存照：
# 11 个历史 release 全靠部署者记忆补装依赖（11-08 曾漏装致首启 ERR_MODULE_NOT_FOUND）。
# 用法：scripts 外手动执行  bash deploy/macos/make-release.sh <commit-hash>
# 产物：~/Projects/estomago-releases/<label>-<短hash>/（含生产依赖，可直接改 start.sh 指向）
set -euo pipefail

COMMIT="${1:?用法: make-release.sh <commit-hash> [label]}"
LABEL="${2:-release}"
SHORT=$(git rev-parse --short "$COMMIT")
DIR="$HOME/Projects/estomago-releases/${LABEL}-${SHORT}"

[ -e "$DIR" ] && { echo "已存在: $DIR"; exit 1; }

# 1) 导出 git 跟踪文件（node_modules 在 .gitignore——archive 不含依赖，见下步）
mkdir -p "$DIR"
git archive "$COMMIT" | tar -x -C "$DIR"

# 2) 装生产依赖（本步不可省：11-08 漏装即启动失败）
cd "$DIR"
npm install --omit=dev --no-audit --no-fund

# 3) 提示后续手工步骤（重启需用户逐次同意，不自动执行）
cat <<EOF
✓ release 就绪: $DIR

剩余步骤（手动）：
  1. 改 ~/Data/estomago-secrets/start.sh 的 cd 路径指向 $DIR
  2. 经用户明确同意后重启: launchctl kickstart -k gui/$(id -u)/online.charstarearth.estomago
  3. 验证: /health/live 与 /health/ready 均 200，且 lsof 确认 cwd=新目录
EOF
