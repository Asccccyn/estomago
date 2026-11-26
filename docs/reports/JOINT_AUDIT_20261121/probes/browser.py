from run_batches import run,pathlib,tempfile
here=pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='joint-ui-') as root:
 home=pathlib.Path(root);(home/'tmp').mkdir();(home/'host').mkdir()
 env=dict(PATH='/opt/homebrew/bin:/usr/bin:/bin',HOME=root,TMPDIR=str(home/'tmp'),ESTOMAGO_HOME=str(home/'host'),ESTOMAGO_TEST_MODE='1',NODE_OPTIONS='--require='+str(here/'local-only.cjs'))
 env['EST_AUDIT_PLAYWRIGHT']=str(pathlib.Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
 code,out=run(['node',str(here/'browser.mjs')],env,50)
 print(out[-1800:]);raise SystemExit(code)
