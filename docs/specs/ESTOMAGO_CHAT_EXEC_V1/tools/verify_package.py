#!/usr/bin/env python3
"""Read-only delivery checks. This does not test or launch estomago."""
from __future__ import annotations
import argparse
import ast
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
from zoneinfo import ZoneInfo

SPEC = 'ESTOMAGO_CHAT_EXEC_V1'
VERIFICATIONS = {'offline_behavioral','source_contract','manual_ui','external_contract','deferred_boundary'}
FIELDS = {'id','title','work_package','requirement_ids','verification','preconditions','steps','expected','evidence_required','status'}

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('package', nargs='?', default=str(Path(__file__).resolve().parents[1]))
    args = ap.parse_args()
    root = Path(args.package).resolve()
    errors = []
    checks = 0
    def check(ok, message):
        nonlocal checks
        checks += 1
        if not ok:
            errors.append(message)
    def read_json(name):
        return json.loads((root/name).read_text(encoding='utf-8'))
    try:
        manifest = read_json('PACKAGE_MANIFEST.json')
        check(manifest['spec_id']==SPEC, 'manifest spec id mismatch')
        entries = manifest['files']
        expected_paths = set()
        for entry in entries:
            rel = entry['path']; pure = PurePosixPath(rel)
            check(not pure.is_absolute() and '..' not in pure.parts, f'unsafe manifest path: {rel}')
            if pure.is_absolute() or '..' in pure.parts:
                continue
            check(rel not in expected_paths, f'duplicate manifest entry: {rel}')
            expected_paths.add(rel)
            p = root/rel
            check(p.is_file() and not p.is_symlink(), f'missing/nonregular artifact: {rel}')
            if not p.is_file() or p.is_symlink():
                continue
            raw=p.read_bytes()
            check(len(raw)==entry['bytes'], f'length mismatch: {rel}')
            check(hashlib.sha256(raw).hexdigest()==entry['sha256'], f'hash mismatch: {rel}')
        actual_paths={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
        check(actual_paths==expected_paths|{'PACKAGE_MANIFEST.json'}, 'unexpected or missing files compared with manifest')
        reqs=read_json('contracts/requirements.json')['requirements']
        acceptance=read_json('contracts/acceptance.json')['cases']
        policy=read_json('contracts/policy-defaults.json')
        api=read_json('contracts/api-index.json')
        fixtures=read_json('fixtures/semantic-cases.json')['cases']
        req_ids={r['id'] for r in reqs}
        check(len(req_ids)==len(reqs), 'duplicate requirement ids')
        prose_ids=set(re.findall(r'^\|\s*(U-[A-Z]+-\d+)\s*\|',(root/'01_REQUIREMENTS_AND_BOUNDARIES.md').read_text(encoding='utf-8'),re.M))
        check(req_ids==prose_ids, 'requirements json and chapter01 differ')
        case_ids=set(); covered=set()
        group_numbers={}
        for c in acceptance:
            check(set(c)==FIELDS, f'case fields: {c.get("id")}')
            cid=c['id']; check(cid not in case_ids, f'duplicate acceptance: {cid}'); case_ids.add(cid)
            check(c['status']=='NOT_EXECUTED', f'original execution package has fabricated/mutated status: {cid}')
            check(c['verification'] in VERIFICATIONS, f'verification type: {cid}')
            check(c['work_package'] in {f'WP{i}' for i in range(9)}, f'unknown work package: {cid}')
            for key in ('requirement_ids','preconditions','steps','expected','evidence_required'):
                check(isinstance(c[key],list) and len(c[key])>0 and all(isinstance(x,str) and x.strip() for x in c[key]), f'invalid/empty case list {cid}/{key}')
            check(set(c['requirement_ids'])<=req_ids, f'unknown requirement in {cid}')
            covered.update(c['requirement_ids'])
            m=re.fullmatch(r'([A-Z]+)-(\d{2})',cid)
            check(m is not None, f'invalid case id: {cid}')
            if m: group_numbers.setdefault(m[1],[]).append(int(m[2]))
        check(covered==req_ids, f'uncovered requirements: {sorted(req_ids-covered)}')
        for group, nums in group_numbers.items():
            check(sorted(nums)==list(range(1,len(nums)+1)), f'non-contiguous group: {group}')
        for r in reqs:
            check(set(r['acceptance_ids'])=={c['id'] for c in acceptance if r['id'] in c['requirement_ids']}, f'requirement coverage index stale: {r["id"]}')
        matrix=(root/'08_ACCEPTANCE_MATRIX.md').read_text(encoding='utf-8')
        check(all(f'| {cid} |' in matrix for cid in case_ids), 'human acceptance matrix incomplete')
        settings={s['key']:s for s in policy['settings']}
        check(len(settings)==len(policy['settings']), 'duplicate policy keys')
        required_values={'cache.anthropic.requested_ttl':'1h','background.keepwarm.idle_after_cache_ms':3000000,'background.autonomous.min_interval_ms':3600000,'windows.soft_limit_tokens':600000,'background.autonomous.enabled':False,'background.keepwarm.enabled':False,'background.reminders.enabled':True,'background.autonomous.daily_cost_cap_usd':None,'background.keepwarm.daily_cost_cap_usd':None,'background.keepwarm.max_model_requests_per_run':1,'background.keepwarm.max_tool_calls_per_run':0}
        for key,value in required_values.items():
            check(key in settings and settings[key]['value']==value, f'policy mismatch: {key}')
        route_ids=set()
        for route in api['routes']:
            check(route['id']==route['method']+' '+route['path'], f'route id mismatch: {route["id"]}')
            check(route['id'] not in route_ids, f'duplicate route: {route["id"]}'); route_ids.add(route['id'])
            check(route['method'] in {'GET','POST','PUT','DELETE'}, f'unsupported new mutation method: {route["id"]}')
            check((root/route['contract']).is_file(), f'missing route chapter: {route["id"]}')
        tool_names=set()
        for tool in api['model_tools']:
            check(tool['name'] not in tool_names, f'duplicate tool {tool["name"]}'); tool_names.add(tool['name'])
            check(tool['route'] is None or tool['route'] in route_ids, f'unknown route for tool {tool["name"]}')
            check(tool['actor']=='host_derived_jiaming', f'untrusted actor in {tool["name"]}')
        for p in root.rglob('*.md'):
            fence=None
            for line in p.read_text(encoding='utf-8').splitlines():
                m=re.match(r'^\s*(`{3,}|~{3,})',line)
                if m:
                    mark=m.group(1)[0]
                    if fence is None: fence=mark
                    elif fence==mark: fence=None
            check(fence is None, f'unclosed markdown fence: {p.name}')
        for p in (root/'tools').glob('*.py'):
            ast.parse(p.read_text(encoding='utf-8'),filename=p.name)
            check(True,f'python parse: {p.name}')
        by_id={f['id']:f for f in fixtures}
        check(len(by_id)==len(fixtures),'duplicate fixture ids')
        dt=lambda s: datetime.fromisoformat(s.replace('Z','+00:00'))
        iso=lambda d: d.isoformat().replace('+00:00','Z')
        f=by_id['F-CACHE-ROLL']
        check(iso(dt(f['events'][-1]['request_start'])+timedelta(milliseconds=f['idle_after_ms']))==f['expected']['next_keepwarm_at'],'cache fixture arithmetic inconsistent')
        f=by_id['F-ROLL60']
        check(iso(dt(f['last_first_dispatch'])+timedelta(milliseconds=f['min_interval_ms']))==f['expected']['next_legal_at'],'cooldown fixture arithmetic inconsistent')
        f=by_id['F-SH-DAY']
        ids=[m['id'] for m in f['messages'] if dt(f['start_utc'])<=dt(m['occurred_at'])<dt(f['end_utc'])]
        check(ids==f['expected']['included_ids'],'calendar fixture boundary inconsistent')
        f=by_id['F-BUDGET-DAY']; zone=ZoneInfo('Asia/Shanghai')
        check(dt(f['dispatch_started_at']).astimezone(zone).date().isoformat()==f['expected']['budget_day'],'budget day fixture inconsistent')
        check(dt(f['usage_observed_at']).astimezone(zone).date().isoformat()==f['expected']['observed_local_day'],'observation day fixture inconsistent')
        f=by_id['F-ALERT-REPLAY']
        check(len(set(f['observation_ids']))==f['expected']['occurrence_count'],'dedupe fixture inconsistent')
        report={'scope':'PACKAGE_INTEGRITY_AND_CONTRACT_COVERAGE_ONLY','implementation_tests':'NOT_RUN','checks':checks,'requirements':len(reqs),'acceptance_cases':len(acceptance),'routes':len(api['routes']),'model_tools':len(api['model_tools']),'fixtures':len(fixtures),'files_in_manifest':len(entries),'status':'FAIL' if errors else 'PASS','errors':errors}
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 1 if errors else 0
    except (OSError,ValueError,KeyError,TypeError,SyntaxError) as exc:
        print(json.dumps({'scope':'PACKAGE_ONLY','status':'FAIL','error':str(exc)},ensure_ascii=False))
        return 1

if __name__=='__main__':
    sys.exit(main())
