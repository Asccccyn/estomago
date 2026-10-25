#!/usr/bin/env python3
"""只验证交付证据格式/文件存在；不能代替运行测试或独立复核。"""
from __future__ import annotations
import argparse,json,re,sys
from pathlib import Path

STATUSES={'NOT_EXECUTED','PASS','FAIL','BLOCKED','NOT_APPLICABLE'}
KINDS={'STATIC_REVIEW','PURE_UNIT','OFFLINE_CONTRACT','ISOLATED_HTTP','MANUAL_DIFF'}

def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--results',type=Path,required=True)
    ap.add_argument('--evidence-root',type=Path,required=True)
    ap.add_argument('--require-complete',action='store_true')
    a=ap.parse_args(); root=a.evidence_root.resolve()
    spec=json.loads((Path(__file__).resolve().parents[1]/'contracts/acceptance.json').read_text(encoding='utf8'))
    result=json.loads(a.results.read_text(encoding='utf8'));errors=[]
    required={x['id'] for x in spec['required']}; rows=result.get('required',[])
    seen=set()
    for item in rows:
        ident=item.get('id');status=item.get('status')
        if ident in seen:errors.append(f'{ident}: duplicate ID')
        seen.add(ident)
        if ident not in required:errors.append(f'{ident}: unknown ID')
        if status not in STATUSES:errors.append(f'{ident}: invalid status')
        if a.require_complete and status!='PASS':errors.append(f'{ident}: not PASS; no silent NA waiver')
        if status=='PASS':
            if not re.fullmatch(r'[0-9a-fA-F]{40}',item.get('actualCommit') or ''):errors.append(f'{ident}: full actualCommit required')
            cmds=item.get('commands',[])
            if not isinstance(cmds,list) or not cmds or not all(isinstance(c,str) and c.strip() for c in cmds):errors.append(f'{ident}: command/inspection steps missing')
            if item.get('evidenceKind') not in KINDS:errors.append(f'{ident}: invalid offline evidenceKind')
            paths=item.get('evidencePaths',[])
            if not isinstance(paths,list) or not paths:errors.append(f'{ident}: evidence path missing');continue
            for p in paths:
                if not isinstance(p,str):errors.append(f'{ident}: invalid path');continue
                resolved=(root/p).resolve()
                if Path(p).is_absolute() or root not in resolved.parents or not resolved.is_file():errors.append(f'{ident}: missing/outside evidence {p}')
    if required-seen:errors.append('missing IDs: '+','.join(sorted(required-seen)))
    for item in result.get('outOfScope',[]):
        if item.get('status')=='PASS':errors.append(f"{item.get('id')}: live/production PASS is outside this package's default authority")
    print(json.dumps({'formatValid':not errors,'errors':errors,'productCorrectnessCertified':False,
                      'independentReviewStillRequired':True},ensure_ascii=False,indent=2))
    return 1 if errors else 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except (ValueError,OSError,json.JSONDecodeError) as e:
        print(str(e),file=sys.stderr);raise SystemExit(2)
