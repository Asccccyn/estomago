import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { assembleTestTools, makeDb, tempRoot } from '../helpers.ts';
import { searchToolCatalog, toolCatalogIntent } from '../../apps/host/src/runtime/tool-catalog-search.ts';
import { definitionId, freezeWindowTools, storedToolset } from '../../apps/host/src/runtime/tool-discovery.ts';

const expectedResident = [
  'memory_hold', 'memory_update', 'memory_recall', 'memory_read_full',
  'image_generate', 'media_view', 'chat_send_voice', 'call_control', 'wake_manage', 'wishstar_write_star', 'wishstar_request_star',
  'content_album_entry_write', 'content_albums_read', 'content_post_create', 'conversation_archive',
];
const expectedTask = ['context_review_complete'];

test('新窗冻结十五份简明用法与一条工具地图提醒，旧窗和显式选择保留各自合同', t => {
  const { db, root } = makeDb(tempRoot('resident-catalog-policy-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { registry } = assembleTestTools({ db, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const declared = registry.currentGroups();
  db.prepare("INSERT INTO conversations(id,owner_service,scope,created_at) VALUES('c','estomago','private','now')").run();
  for (const id of ['w-legacy', 'w-new', 'w-explicit']) {
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES(?,'c','ACTIVE','now','now')").run(id);
  }

  const storeSelection = db.prepare("INSERT INTO runtime_settings(key,value,updated_at) VALUES('tools_initial_visible',?,'now')");
  storeSelection.run(JSON.stringify(expectedResident.filter(name => name !== 'chat_send_voice' && name !== 'call_control' && name !== 'conversation_archive')));
  freezeWindowTools(db, 'w-legacy', catalog, 'deferred', declared);
  const legacy = storedToolset(db, 'w-legacy')!;
  assert.equal(legacy.groups.chat_send_voice, 'D');
  assert.equal(legacy.groups.call_control, 'D');
  assert.equal(legacy.groups.conversation_archive, 'D');
  db.prepare("DELETE FROM runtime_settings WHERE key='tools_initial_visible'").run();

  freezeWindowTools(db, 'w-new', catalog, 'deferred', declared);
  const frozen = storedToolset(db, 'w-new')!;
  const initial = frozen.initialText!;
  assert.deepEqual([...initial.matchAll(/^- ([a-z_]+)$/gm)].map(match => match[1]), expectedResident);
  assert.deepEqual(Object.keys(frozen.groups).filter(name => frozen.groups[name] === 'T'), expectedTask);
  assert.equal(frozen.groups.heartbeat_draw, 'D');
  assert.equal(frozen.groups.wishstar_reply_star, 'D');
  assert.equal(Object.values(frozen.groups).filter(group => group === 'D').length, 41);
  assert.ok(initial.startsWith('你想记下一件事'));
  assert.equal([...initial.matchAll(/用 tool_catalog 的 query/g)].length, 1);
  assert.match(initial, /发现记错了也可以改/);
  assert.match(initial, /tool_catalog 的 query/);
  assert.match(initial, /expected_version/);
  assert.match(initial, /asset_ref/);
  assert.match(initial, /^- chat_send_voice\n[^\n]*填 text/m);
  assert.match(initial, /^- wishstar_write_star\n[^\n]*填 text/m);
  assert.match(initial, /^- content_post_create\n[^\n]*填 text/m);
  assert.match(initial, /^- call_control\n[^\n]*action: invite/m);
  assert.doesNotMatch(initial, /发语音，就到工具地图/);
  assert.ok(!initial.includes('parameters: {'));
  assert.ok(!/^- (conversation_read|background_complete|context_review_complete)$/m.test(initial));
  assert.deepEqual(frozen.catalog, catalog);

  storeSelection.run(JSON.stringify(['memory_hold', 'conversation_read', 'background_complete']));
  freezeWindowTools(db, 'w-explicit', catalog, 'deferred', declared);
  const explicit = storedToolset(db, 'w-explicit')!;
  assert.equal(explicit.groups.memory_hold, 'C');
  assert.equal(explicit.groups.conversation_read, 'C');
  assert.equal(explicit.groups.memory_recall, 'D');
  assert.equal(explicit.groups.background_complete, 'C');
  assert.match(explicit.initialText!, /- conversation_read/);
  assert.doesNotMatch(explicit.initialText!, /问宿主用户要一颗星/);
  assert.deepEqual(storedToolset(db, 'w-new'), frozen);
  assert.deepEqual(storedToolset(db, 'w-legacy'), legacy);
});

test('自然意图匹配真实工具并一次返回该窗口的完整定义', () => {
  const { registry } = assembleTestTools({ db: {} as never, media: {} as never, messages: {} as never });
  const catalog = registry.currentCatalog();
  const groups = registry.currentGroups();
  for (const [query, expected] of [
    ['我想看看我们昨天聊了什么', 'conversation_read'],
    ['把昨天晚上我们说的话找出来', 'conversation_read'],
    ['我想翻翻以前的甜蜜存档', 'archives_search'],
    ['把生成的图片保存到相册', 'content_album_entry_write'],
    ['把刚才那句话收进那条记忆里', 'memory_words_write'],
    ['我要把这句话留进我们的记忆里', 'memory_words_write'],
    ['发一条语音给她', 'chat_send_voice'],
    ['想主动给她打电话', 'call_control'],
    ['帮我改计划', 'plans_write'],
    ['我想在本轮心跳抽卡选号码', 'heartbeat_draw'],
    ['回应抽到的星', 'wishstar_reply_star'],
    ['拒绝抽卡', 'background_complete'],
    ['memory_recall', 'memory_recall'],
  ]) {
    const result = searchToolCatalog(catalog, query, groups);
    assert.equal(result.state, 'match', query);
    if (result.state !== 'match') continue;
    const hit = result.results[0]!;
    const spec = catalog.find(entry => entry.function.name === expected)!;
    assert.equal(hit.name, expected, query);
    assert.equal(hit.definition_id, definitionId(spec));
    assert.deepEqual(hit.parameters, spec.function.parameters);
  }
  for (const spec of catalog) {
    const name = spec.function.name;
    const phrase = toolCatalogIntent(name);
    assert.ok(phrase, name);
    const result = searchToolCatalog(catalog, phrase, groups);
    assert.equal(result.state === 'match' && result.results[0]?.name, name, phrase);
  }
  assert.equal(searchToolCatalog(catalog, '想订一杯咖啡').state, 'no_match');
});
