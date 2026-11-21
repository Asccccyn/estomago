"""Reuse the repository's image path assertions with a synthetic, two-frame GIF."""
from run_batches import run, repo, pathlib, tempfile
import base64,re
here=pathlib.Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='joint-gif-') as root:
 home=pathlib.Path(root); (home/'tmp').mkdir(); (home/'host').mkdir()
 src=repo/'tests/integration/album-image-delivery.test.ts'
 code=src.read_text()
 def absolute(m):
  return "from '"+str((src.parent/m.group(1)).resolve())+"'"
 code=re.sub(r"from '(\.\.?/[^']+)'",absolute,code)
 (home/'node_modules').symlink_to(repo/'node_modules')
 # Global color table followed by two 1x1 image descriptors and a trailer.
 header=bytes.fromhex('47494638396101000100800000000000ffffff')
 frame=bytes.fromhex('21f904000a0000002c0000000001000100000202')
 gif=header+frame+bytes.fromhex('440100')+frame+bytes.fromhex('4c0100')+b';'
 code=re.sub(r"const PNG = Buffer.from\('[^']+'","const PNG = Buffer.from('"+base64.b64encode(gif).decode()+"'",code)
 code=code.replace("c.mimeType==='image/png'","c.mimeType==='image/gif'")
 check="assert.equal(envelope.messages[1].content[1].type,'image');"
 code=code.replace(check,check+"assert.equal(envelope.messages[1].content[1].source.media_type,'image/gif');")
 check="assert.equal(frame.message.content[0].content[1].type,'image');"
 code=code.replace(check,check+"assert.equal(frame.message.content[0].content[1].source.media_type,'image/gif');")
 test=home/'gif.test.ts';test.write_text(code)
 env=dict(PATH='/opt/homebrew/bin:/usr/bin:/bin',HOME=root,TMPDIR=str(home/'tmp'),ESTOMAGO_HOME=str(home/'host'),ESTOMAGO_TEST_MODE='1',NODE_OPTIONS='--require='+str(here/'local-only.cjs'))
 rc,out=run(['node',str(test)],env,40)
 print('\n'.join(l for l in out.splitlines() if l.startswith(('ok ','not ok ','# pass','# fail','  error:','{"evidence"'))))
 raise SystemExit(rc)
