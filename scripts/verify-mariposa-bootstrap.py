"""Real loopback HTTP contract check: Mariposa -> est client -> window bootstrap.

Usage: python3 scripts/verify-mariposa-bootstrap.py --mariposa-repo /path/to/mariposa
       [--baseline-estomago-repo /path/to/accepted/estomago]
Only synthetic temporary roots are used. No model runner, messages or live services.
The optional baseline is read-only code used for byte-exact successful-output comparison.
Omitting it is reported as baseline_verified=false, never as a passed baseline check.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]

def stop(process):
    if process.poll() is None:
        os.killpg(process.pid,signal.SIGTERM)
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL);process.wait()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--mariposa-repo',type=Path,required=True)
    ap.add_argument('--baseline-estomago-repo',type=Path)
    ap.add_argument('--python',type=Path)
    ap.add_argument('--port',type=int,default=18882)
    ap.add_argument('--output',type=Path)
    args=ap.parse_args()
    mariposa=args.mariposa_repo.resolve()
    python=args.python or mariposa/'.venv/bin/python'
    if not (mariposa/'backend/mariposa/app.py').is_file():raise RuntimeError('Not a Mariposa source checkout')
    baseline=args.baseline_estomago_repo.resolve() if args.baseline_estomago_repo else None
    if baseline and not (baseline/'apps/host/src/runtime/supervisor.ts').is_file():
        raise RuntimeError('Not an accepted estomago source checkout')
    with socket.socket() as check:check.bind(('127.0.0.1',args.port))
    output=(args.output or Path(tempfile.mkdtemp(prefix='mariposa-cross-result-'))).resolve();output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='est-mariposa-contract-') as tmp:
        base=Path(tmp);fixture=ROOT/'tests/cross-project/mariposa_bootstrap_fixture.py'
        env={key:os.environ[key] for key in ('PATH','HOME','TMPDIR','LANG','LC_ALL') if key in os.environ}
        env.update(ESTOMAGO_TEST_MODE='1',ESTOMAGO_HOME=str(base/'estomago'),CROSS_PROJECT_TEMP_ROOT=str(base),
                   PYTHONPATH=str(mariposa/'backend'),PYTHONDONTWRITEBYTECODE='1',MARIPOSA_ROOT=str(base/'mariposa'),MARIPOSA_ALLOW_CREATE='1',
                   MARIPOSA_SEMANTIC_PROVIDER='',MARIPOSA_RECALL_JUDGE_PROVIDER='disabled',
                   ESTOMAGO_TEST_MARIPOSA_TOKEN='synthetic-est-bootstrap',CROSS_MARIPOSA_URL=f'http://127.0.0.1:{args.port}',
                   CROSS_MARIPOSA_PYTHON=str(python),CROSS_MARIPOSA_FIXTURE=str(fixture),CROSS_MARIPOSA_EXPECTED=str(base/'expected.json'),CROSS_MARIPOSA_RESULT=str(output/'result.json'))
        if baseline:env['CROSS_ESTOMAGO_BASELINE']=str(baseline)
        subprocess.run(['node','scripts/test-guard.mjs'],cwd=ROOT,env=env,check=True,timeout=10)
        subprocess.run([str(python),'-B',str(fixture),'seed'],cwd=ROOT,env=env,check=True,timeout=30)
        with (output/'server.log').open('w') as log:
            server=subprocess.Popen([str(python),'-B','-m','uvicorn','mariposa.app:app','--host','127.0.0.1','--port',str(args.port),'--no-access-log'],env=env,cwd=mariposa,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                for _ in range(100):
                    if server.poll() is not None:raise RuntimeError('Isolated Mariposa failed; inspect server.log')
                    try:
                        with urllib.request.urlopen(env['CROSS_MARIPOSA_URL']+'/health',timeout=.3) as response:
                            if response.status==200:break
                    except OSError:time.sleep(.05)
                else:raise TimeoutError('Isolated Mariposa did not become ready')
                child=subprocess.Popen(['node','tests/cross-project/bootstrap-pagination.test.ts'],env=env,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
                try:
                    text,_=child.communicate(timeout=90)
                    (output/'test.log').write_text(text);print(text)
                    return child.returncode
                finally:stop(child)
            finally:stop(server)

if __name__=='__main__':raise SystemExit(main())
