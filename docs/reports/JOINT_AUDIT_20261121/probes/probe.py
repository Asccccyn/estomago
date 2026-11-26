"""Capture actual Host request and persistence facts using synthetic transports."""
import json
import os
from pathlib import Path
import sys
import tempfile
from run_batches import run

HERE = Path(__file__).resolve().parent
CASES = {
    'normal': [
        ('api', 'direct', 'send'),
        ('sdk', 'direct', 'silent'),
        ('api', 'deferred', 'silent'),
        ('sdk', 'deferred', 'send'),
        ('api', 'direct', 'short'),
    ],
    'extra': [
        ('api', 'direct', 'budget'),
        ('api', 'direct', 'unpriced'),
        ('api', 'direct', 'text'),
        ('sdk', 'deferred', 'text'),
    ],
    'unknown': [('api', 'direct', 'unknown')],
    'album': [('api', 'direct', 'album')],
    'clock': [('api', 'direct', 'clock'), ('sdk', 'direct', 'midnight')],
}

def execute(case, destination):
    lane, protocol, ending = case
    with tempfile.TemporaryDirectory(prefix='joint-probe-') as work:
        home = Path(work)
        (home / 'tmp').mkdir()
        (home / 'host').mkdir()
        env = dict(PATH='/opt/homebrew/bin:/usr/bin:/bin', HOME=work,
                   ESTOMAGO_HOME=str(home / 'host'), TMPDIR=str(home / 'tmp'),
                   ESTOMAGO_TEST_MODE='1', NODE_OPTIONS='--require=' + str(HERE / 'local-only.cjs'))
        code, log = run(['node', str(HERE / 'joint.mjs'), *case], env, 55)
        summary = next((line for line in reversed(log.splitlines()) if line.startswith('{"lane"')), None)
        if summary is None:
            raise RuntimeError(f'{case} exited {code} without a measurement: {log[-1400:]}')
        observed = json.loads(summary)
        suffix = '' if ending in ('send', 'silent') else '-' + ending
        output = destination / f'{lane}-{protocol}{suffix}.json'
        output.write_text(json.dumps(observed, ensure_ascii=False, indent=2) + '\n')
        if code or observed['exceptions']:
            raise RuntimeError(f'{case} did not finish; see {output}')
        print(f'{lane} {protocol} {ending}: {observed["run"]}', flush=True)

if __name__ == '__main__':
    destination = Path(os.environ.get('ESTOMAGO_AUDIT_OUTPUT') or tempfile.mkdtemp(prefix='joint-results-'))
    destination.mkdir(parents=True, exist_ok=True)
    print('Output:', destination, flush=True)
    for group in sys.argv[1:] or ['normal']:
        for case in CASES[group]:
            execute(case, destination)
