"""Run selected repository tests one at a time in credential-free, disposable homes."""
import os
import pathlib
import signal
import subprocess
import sys
import tempfile

def find_repo():
    if 'ESTOMAGO_AUDIT_REPO' in os.environ:
        return pathlib.Path(os.environ['ESTOMAGO_AUDIT_REPO']).resolve()
    for parent in pathlib.Path(__file__).resolve().parents:
        if (parent/'scripts/test-guard.mjs').is_file():
            return parent
    return pathlib.Path('/Users/owner/Projects/estomago')

repo = find_repo()
groups = {
    'revisions': 'integration/content-source-revisions unit/wake-keepwarm unit/keepwarm-sleep unit/full-audit-tool-budget unit/wishstar-integration unit/content-carry unit/carry-images',
    'retirement': 'unit/exec-v1-wp4-executor unit/native-tool-snapshot unit/imagegen integration/frozen-tool-package',
    'turn': 'integration/heartbeat-v12-orchestration integration/completion-r33-recovery unit/turn-completion-sdk integration/cache-maintenance-c07-c09 integration/heartbeat-note-delete-race integration/background-product-chain integration/sdk-host-continuity',
    'content': 'integration/content-source-revisions unit/content-moments-http unit/zashidele-moments unit/heartbeat-cards unit/heartbeat-audio-sources integration/native-mcp-direct unit/tool-task-discovery',
    'album': 'unit/album-upload unit/static-svg-media unit/image-creation-migration-plan integration/album-image-delivery unit/carry-alias-identity unit/carry-hash-authority integration/home-chat-navigation',
}
def run(command, env, limit):
    p = subprocess.Popen(command, cwd=repo, env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        out, _ = p.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)
        out, _ = p.communicate()
    try:
        os.killpg(p.pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError(f'audit group still alive: {p.pid}')
    return p.returncode, out.decode(errors='replace')
if __name__ == '__main__':
    failures = []
    for group in sys.argv[1:]:
        for test in groups[group].split():
            with tempfile.TemporaryDirectory(prefix='joint-est-audit-') as work:
                home = pathlib.Path(work)
                (home / 'tmp').mkdir()
                (home / 'host').mkdir()
                env = dict(PATH='/opt/homebrew/bin:/usr/bin:/bin', HOME=work, TMPDIR=str(home/'tmp'), LANG='en_US.UTF-8', ESTOMAGO_HOME=str(home/'host'), ESTOMAGO_TEST_MODE='1')
                env['NODE_OPTIONS'] = '--require=' + str(pathlib.Path(__file__).with_name('local-only.cjs').resolve())
                code, log = run(['node', 'scripts/test-guard.mjs'], env, 10)
                if code: raise RuntimeError('guard')
                code, log = run(['node', 'tests/'+test+'.test.ts'], env, 85)
                if code:
                    failures.append(test)
                print(test, 'exit', code, 'group_empty', flush=True)
                print('\n'.join(l for l in log.splitlines() if l.startswith(('ok ','not ok ','# tests','# pass','# fail','✔','✖','ℹ tests','ℹ pass','ℹ fail','  Error','  AssertionError','  code:','  error:','    at ')))[:4500], flush=True)

    if failures:
        raise SystemExit('Failed files: ' + ', '.join(failures))
