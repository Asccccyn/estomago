"""Synthetic current bootstrap data; never read or mutate a production root."""
import hashlib
import json
import os
from pathlib import Path
import sys

base = Path(os.environ['CROSS_PROJECT_TEMP_ROOT']).resolve()
root = Path(os.environ['MARIPOSA_ROOT']).resolve()
if os.environ.get('ESTOMAGO_TEST_MODE') != '1' or not root.is_relative_to(base):
    raise RuntimeError('Fixture requires the isolated cross-project test root')

from mariposa import db, schema
from mariposa.identity import service as identity
from mariposa.identity_i import service as identity_i
from mariposa.memory import service as memory
from mariposa.memory.extras import update_mood, update_text
from mariposa.plans import service as plans

mode = sys.argv[1] if len(sys.argv) > 1 else 'seed'
expected_file = base / 'expected.json'


def mood_text(index, revision):
    return (f'MOOD_{index}_REV{revision}_HEAD|'
            + ('😀\x01心\n\t' * 1200)
            + f'|MOOD_{index}_REV{revision}_TAIL')


if mode == 'seed':
    schema.migrate()
    schema.migrate_runtime()
    identity.seed({'qiaosheng': 'synthetic-q', 'jiaming': 'synthetic-j', 'worker': 'synthetic-w'})
    token = 'synthetic-est-bootstrap'
    with db.formal() as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert not {'anniversary_definitions', 'anniversary_occurrences'} & tables
        conn.execute(
            'INSERT INTO client_bindings(binding_id,token_hash,principal_id,entry_source,revoked,created_at,capabilities_allowlist) '
            "VALUES(?,?,?,?,0,datetime('now'),?)",
            ('cross-bootstrap', hashlib.sha256(token.encode()).hexdigest(), 'jiaming', 'estomago_builtin',
             json.dumps(['bootstrap.get', 'bootstrap.next'])))
    actor = identity.authenticate('synthetic-j')
    expected = {'revision': 0, 'moods': {}, 'buckets': {}}
    for index in range(2):
        mood = mood_text(index, 0)
        event = f'EVENT_{index}_REV0_FULL 合成事件正文完整保留'
        words = [
            {'speaker': 'qiaosheng', 'text': f'WORD_{index}_Q_FULL 合成话语甲'},
            {'speaker': 'jiaming', 'text': f'WORD_{index}_J_FULL 合成话语乙'},
        ]
        result = memory.hold(
            actor, event, original_title=f'跨项目心情{index}',
            categories=['anniversary' if index == 0 else 'daily'],
            creation_mode='contemporaneous', mood={'tags': ['开心'], 'text': mood}, our_words=words)
        mid = result['memory_id']
        expected['moods'][mid] = mood
        expected['buckets'][mid] = {'event': event, 'words': [word['text'] for word in words], 'version': result['version']}
    expected['target_memory_id'] = next(iter(expected['moods']))
    expected['i'] = 'I_REV0_FULL 合成自我认知完整保留'
    expected['i_ref'] = identity_i.item_create('jiaming', expected['i'])
    expected['plan'] = {'title': 'PLAN_REV0_TITLE', 'content': 'PLAN_REV0_FULL 合成计划正文完整保留'}
    expected['plan_ref'] = plans.create('jiaming', **expected['plan'], state='active')
    expected_file.write_text(json.dumps(expected, ensure_ascii=False))
    print(json.dumps({'seeded_memories': len(expected['moods']), 'seeded_i': 1, 'seeded_plans': 1, 'seeded_words': 4, 'independent_anniversaries_retired': True}))
elif mode == 'mutate':
    # Change several independent fields before the next HTTP read. A restarted
    # snapshot must replace the whole old package, not just repair a mood tail.
    expected = json.loads(expected_file.read_text())
    revision = expected['revision'] + 1
    mid = expected['target_memory_id']
    expected['moods'][mid] = mood_text(0, revision)
    update_mood('jiaming', mid, {'text': expected['moods'][mid], 'tags': ['开心']})
    event = f'EVENT_0_REV{revision}_FULL 合成事件正文完整保留'
    changed = update_text('jiaming', mid, expected['buckets'][mid]['version'], text=event)
    expected['buckets'][mid].update(event=event, version=changed['version'])
    expected['i'] = f'I_REV{revision}_FULL 合成自我认知完整保留'
    expected['i_ref'] = identity_i.item_revise('jiaming', expected['i_ref']['item_id'], expected['i'], expected['i_ref']['revision'])
    expected['plan'] = {'title': f'PLAN_REV{revision}_TITLE', 'content': f'PLAN_REV{revision}_FULL 合成计划正文完整保留'}
    expected['plan_ref'] = plans.update('jiaming', expected['plan_ref']['plan_id'], expected['plan_ref']['version'], **expected['plan'])
    expected['revision'] = revision
    expected_file.write_text(json.dumps(expected, ensure_ascii=False))
    print(json.dumps({'mutated_snapshot_revision': revision}))
else:
    raise ValueError('Unknown fixture action')
