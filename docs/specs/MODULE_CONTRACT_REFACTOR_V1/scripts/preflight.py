#!/usr/bin/env python3
"""只读基线检查。不读取凭据/生产资料，不写仓库，不调用网络或模型。"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path

EXPECTED = '849b1d51da7ff4c245c30d4786bcf1edaaa3d121'
KNOWN_DIRTY = {'apps/web/dist/chat-app.js', 'apps/web/dist/index.html'}
ANCHORS = [
    'AGENTS.md', 'package.json', 'scripts/run-tests.mjs', 'scripts/test-guard.mjs',
    'apps/host/src/runtime/host-tools.ts', 'apps/host/src/runtime/supervisor.ts',
    'apps/host/src/runtime/tool-discovery.ts', 'apps/host/src/runtime/model-results.ts',
    'apps/host/src/runtime/background-tool-cost.ts', 'apps/host/src/messages/service.ts',
    'apps/host/src/app-context.ts', 'apps/host/src/server/http.ts',
]

def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(['git', '-C', str(repo), *args], text=True, capture_output=True,
                          timeout=30, check=check)

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', type=Path, required=True)
    ns = ap.parse_args()
    repo = ns.repo.expanduser().resolve()
    if not repo.is_dir():
        raise ValueError('仓库目录不存在')
    head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
    branch = git(repo, 'branch', '--show-current').stdout.strip()
    status = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all').stdout
    # -z的rename记录有第二个路径；仅输出路径，不读取文件内容。
    parts = iter(status.split('\0'))
    dirty = []
    for entry in parts:
        if not entry:
            continue
        code, name = entry[:2], entry[3:]
        item = {'status': code, 'path': name, 'knownDistOnly': name in KNOWN_DIRTY}
        if 'R' in code or 'C' in code:
            item['oldPath'] = next(parts, '')
        dirty.append(item)
    relation = 'exact_observed_baseline' if head == EXPECTED else 'different_requires_reconciliation'
    if head != EXPECTED:
        exists = git(repo, 'cat-file', '-e', EXPECTED+'^{commit}', check=False)
        if exists.returncode == 0:
            anc = git(repo, 'merge-base', '--is-ancestor', EXPECTED, head, check=False)
            if anc.returncode == 0:
                relation = 'descendant_requires_diff_review'
    node = shutil.which('node')
    if not node and os.access('/opt/homebrew/bin/node', os.X_OK):
        node = '/opt/homebrew/bin/node'
    node_version = None
    if node:
        p = subprocess.run([node, '--version'], text=True, capture_output=True, timeout=10)
        node_version = p.stdout.strip() if p.returncode == 0 else None
    missing = [s for s in ANCHORS if not (repo/s).is_file()]
    scripts = {}
    if (repo/'package.json').is_file():
        scripts = json.loads((repo/'package.json').read_text(encoding='utf-8')).get('scripts', {})
    blockers = []
    if missing: blockers.append('源码锚点缺失，需要人工定位，不自动猜路径')
    if any(not x['knownDistOnly'] for x in dirty):
        blockers.append('存在非已知dist未提交改动，先确认是否影响真实基线')
    if not node_version: blockers.append('Node不可执行，检查既有安装/PATH，不自动安装或升级')
    result = {
        'mode': 'READ_ONLY', 'repository': str(repo), 'head': head, 'branch': branch,
        'observedBaseline': EXPECTED, 'relation': relation, 'dirty': dirty,
        'nodeExecutable': node, 'nodeVersion': node_version, 'missingAnchors': missing,
        'packageScripts': scripts, 'blockers': blockers,
        'decision': 'REQUIRES_HUMAN_BASELINE_REVIEW' if blockers or head != EXPECTED else 'BASELINE_OBSERVED_NOT_PRODUCT_VALIDATED',
        'productTestsRun': False, 'productionInspected': False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if blockers or head != EXPECTED else 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as e:
        print(json.dumps({'error': str(e), 'mode':'READ_ONLY', 'productTestsRun':False}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
