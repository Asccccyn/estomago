#!/usr/bin/env python3
"""检查某卡起始SHA至当前树的路径范围；只读，不判定业务正确。"""
from __future__ import annotations
import argparse, fnmatch, json, re, subprocess, sys
from pathlib import Path

def run(repo: Path, *args: str) -> str:
    return subprocess.run(['git', '-C', str(repo), *args], text=True, capture_output=True,
                          check=True, timeout=30).stdout

def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo',type=Path,required=True)
    ap.add_argument('--base',required=True,help='本卡开始时完整或短提交SHA，不是专项总基线')
    ap.add_argument('--stage',required=True)
    ap.add_argument('--policy',type=Path,default=Path(__file__).resolve().parents[1]/'contracts/change-scope.json')
    a=ap.parse_args(); repo=a.repo.expanduser().resolve()
    if not re.fullmatch(r'[0-9a-fA-F]{7,40}',a.base):raise ValueError('--base必须为提交SHA')
    run(repo,'rev-parse','--verify',a.base+'^{commit}')
    policy=json.loads(a.policy.read_text(encoding='utf8'))
    allowed=policy['stages'].get(a.stage)
    if allowed is None:raise ValueError('未知stage')
    changed=set(x for x in run(repo,'diff','--no-renames','--name-only','-z',a.base,'--').split('\0') if x)
    changed.update(x for x in run(repo,'ls-files','--others','--exclude-standard','-z').split('\0') if x)
    denied=[]
    for p in sorted(changed):
        if any(fnmatch.fnmatchcase(p,g) for g in policy['alwaysForbidden']):
            denied.append({'path':p,'reason':'requires_explicit_scope_decision'})
        elif not any(fnmatch.fnmatchcase(p,g) for g in allowed):
            denied.append({'path':p,'reason':'outside_card_allowlist'})
    print(json.dumps({'stage':a.stage,'base':a.base,'files':sorted(changed),'violations':denied,
                      'scopeOnly':True,'semanticApproval':False},ensure_ascii=False,indent=2))
    return 1 if denied else 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except (ValueError,OSError,subprocess.SubprocessError,json.JSONDecodeError) as e:
        print(str(e),file=sys.stderr);raise SystemExit(2)
