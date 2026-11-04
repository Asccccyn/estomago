// Same explicit vendor workflow as sync-oido-model-contract; never fetch at runtime.
import fs from 'node:fs';
import path from 'node:path';
const source = process.argv[2];
if (!source) throw Error('Pass the Mariposa contracts directory');
const text = fs.readFileSync(path.join(source, 'capabilities.v1.json'), 'utf8');
const data = JSON.parse(text);
if (!data.source_commit || !data.source_files || !data.capabilities.every(c => c.input_schema)) throw Error('Incomplete Mariposa contract');
const target = new URL('../apps/host/src/integrations/mariposa/contracts/capabilities.v1.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) throw Error('Mariposa contract is stale; regenerate from the declared source');
} else {
  fs.mkdirSync(new URL('.', target), { recursive: true });
  fs.writeFileSync(target, text);
}
