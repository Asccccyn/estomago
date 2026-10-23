// Explicit build-time vendor step, never a runtime cross-repository import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const source=process.argv[2];
if(!source)throw new Error('Pass the oído contracts directory');
const projection=fs.readFileSync(path.join(source,'projections.oido.v1.schema.json'));
const budgets=fs.readFileSync(path.join(source,'json_budgets.json'));
const out={source:'oido/contracts',sha256:{projection:crypto.createHash('sha256').update(projection).digest('hex'),budgets:crypto.createHash('sha256').update(budgets).digest('hex')},schema:JSON.parse(projection),budgets:JSON.parse(budgets)};
fs.writeFileSync(new URL('../apps/host/src/integrations/oido/contracts/model-projection.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
