#!/usr/bin/env python3
"""Read-only repository baseline check. Never fetches, resets, starts services or reads secrets."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo',required=True)
    ap.add_argument('--package',default=str(Path(__file__).resolve().parents[1]))
    args=ap.parse_args()
    repo=Path(args.repo).resolve(); root=Path(args.package).resolve()
    try:
        manifest=json.loads((root/'PACKAGE_MANIFEST.json').read_text(encoding='utf-8'))
        def git(*argv):
            result=subprocess.run(['git','-C',str(repo),*argv],text=True,capture_output=True,timeout=15,check=False)
            if result.returncode:
                raise ValueError('git '+argv[0]+' failed; check target repository')
            return result.stdout.rstrip('\n')
        if git('rev-parse','--is-inside-work-tree')!='true':
            raise ValueError('target is not a git work tree')
        head=git('rev-parse','HEAD')
        dirty=git('status','--porcelain=v1','--untracked-files=normal').splitlines()
        changed=[]; checked=0
        for entry in manifest['source_baseline']['files']:
            rel=entry['path']; pure=PurePosixPath(rel)
            if pure.is_absolute() or '..' in pure.parts:
                raise ValueError('unsafe baseline path in manifest')
            p=repo/rel; checked+=1
            if not p.is_file() or p.is_symlink():
                changed.append({'path':rel,'state':'missing_or_nonregular'})
            elif hashlib.sha256(p.read_bytes()).hexdigest()!=entry['sha256']:
                changed.append({'path':rel,'state':'changed'})
        drift=head!=manifest['source_baseline']['commit'] or bool(changed) or bool(dirty)
        report={'scope':'READ_ONLY_SOURCE_PREFLIGHT','expected_commit':manifest['source_baseline']['commit'],'actual_commit':head,'checked_files':checked,'changed_baseline_files':changed,'working_tree_entries':dirty,'status':'REVIEW_NEEDED' if drift else 'BASELINE_MATCH','instruction':'Review current changes and continue non-conflicting work. Do not reset or overwrite. No code tests or live checks were run.'}
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 2 if drift else 0
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired) as exc:
        print(json.dumps({'scope':'READ_ONLY_SOURCE_PREFLIGHT','status':'ERROR','error':str(exc)},ensure_ascii=False))
        return 1

if __name__=='__main__':
    sys.exit(main())
