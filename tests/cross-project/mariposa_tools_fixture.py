"""Seed synthetic domain objects for the existing isolated HTTP contract runner."""
import json
import os
from pathlib import Path

base = Path(os.environ['CROSS_PROJECT_TEMP_ROOT']).resolve()
root = Path(os.environ['MARIPOSA_ROOT']).resolve()
if os.environ.get('ESTOMAGO_TEST_MODE') != '1' or not root.is_relative_to(base):
    raise RuntimeError('Requires the isolated cross-project root')

from mariposa import schema
from mariposa.identity import service as identity
from mariposa.capabilities import registry

schema.migrate()
schema.migrate_runtime()
identity.seed({'qiaosheng': 'synthetic-q', 'jiaming': 'synthetic-est-bootstrap', 'worker': 'synthetic-w'})
actor = identity.authenticate('synthetic-est-bootstrap')
from mariposa.source import ingest
ingest.create_grant(identity.authenticate('synthetic-w').binding_id, 'estomago-primary-live', 'estomago', 'primary', ['user','assistant'], 'private', 'qiaosheng')
from mariposa.recall import judge_policy
judge_policy.update_policy('qiaosheng', expected_revision=judge_policy.get_policy()['revision'], enabled=False)
def call(name, args):
    return registry.invoke(actor, name, args, None)['data']

memories = [call('memory.hold', {'text': f'合成事件 {i}：AbC  原生空格。\n第二行',
    'original_title': f'合成{i}', 'categories': ['daily'], 'creation_mode': 'contemporaneous', **({'our_words':[{'speaker':'jiaming','text':'先前保存的合成原话 AbC'}]} if i==0 else {})})['memory_id'] for i in range(12)]
for earlier, later in zip(memories, memories[1:]):
    call('memory.relations.link', {'from_memory': later, 'to_memory': earlier, 'relation_type': 'continuation_of'})
plan = call('plan.create', {'title': '合成计划', 'link_memory_ids': [memories[0]]})
item = call('i.item.create', {'content': '合成 I 条目', 'relations': [{'memory_id': memories[0], 'relation_type': 'related_to'}]})
from mariposa.source import importer
source_file = base/'sources.json'
source_file.write_text(json.dumps([{'uuid':'synthetic-raw','chat_messages':[
    {'uuid':f'raw-{i}', 'sender':'human', 'created_at':f'2026-09-20T10:{i:02d}:00Z',
     'content':[{'type':'text','text':f'原文续查锚点 AbC  合成{i}'}]} for i in range(25)]}],ensure_ascii=False))
importer.import_file('jiaming', str(source_file))
raw_first = call('memory.recall.start', {'conversation_scope':'primary', 'request_ref':'synthetic-raw-first',
    'query_plan':{'original_request':'原文续查锚点','lexical_terms':['原文续查锚点']}})
assert raw_first['continuation']['reason'] == 'NO_DELIVERABLE_CANDIDATE'
(base/'expected.json').write_text(json.dumps({'memories': memories, 'plan': plan, 'item': item, 'raw_first': raw_first}, ensure_ascii=False))
print(json.dumps({'memories': len(memories), 'plans': 1, 'items': 1}))
