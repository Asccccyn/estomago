import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../../apps/host/src/config/yaml.ts';
import { validateConfig } from '../../apps/host/src/config/schema.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const exampleYaml = fs.readFileSync(path.join(REPO, 'config', 'estomago.example.yaml'), 'utf8');

test('随包 example.yaml 可解析且通过严格校验', () => {
  const raw = parseYaml(exampleYaml);
  const { config, issues } = validateConfig(raw);
  assert.deepEqual(issues, []);
  assert.equal(config.project.slug, 'estomago');
  assert.equal(config.deployment.port, 18787);
  assert.equal(config.runtime.setting_sources.length, 0);
  assert.equal(config.runtime.thinking.display, 'summarized');
  assert.equal(config.input.enter_behavior, 'newline');
  assert.equal(config.reasoning.label, '思考');
});

test('YAML 子集：嵌套 map / 内联空列表 / 引号字符串 / null / 布尔 / 数字', () => {
  const v = parseYaml(`
a: '0.2.1'
b: true
c: 18787
d: null
e: []
nested:
  x: false
  deeper:
    y: '字面量'
list:
  - one
  - two
`);
  assert.equal(v.a, '0.2.1');
  assert.equal(v.b, true);
  assert.equal(v.c, 18787);
  assert.equal(v.d, null);
  assert.deepEqual(v.e, []);
  const nested = v.nested as { x: boolean; deeper: { y: string } };
  assert.equal(nested.x, false);
  assert.equal(nested.deeper.y, '字面量');
  assert.deepEqual(v.list, ['one', 'two']);
});

test('未知配置键 → 报 issue（不忽略）', () => {
  const { issues } = validateConfig({ project: { slug: 'estomago', display_name: 'x', spec_version: '1', no_such_key: 1 } });
  assert.ok(issues.some((i) => i.message.includes('未知配置键')));
});

test('类型错配 → 报 issue', () => {
  const { issues } = validateConfig({ deployment: { port: '一万八' } });
  assert.ok(issues.some((i) => i.path === 'deployment.port'));
});

test('产品硬规则：Enter 发送被拒绝', () => {
  const { issues } = validateConfig({ input: { enter_behavior: 'send' } });
  assert.ok(issues.some((i) => i.message.includes('enter_behavior')));
});

test('产品硬规则：签名进 UI / 摘要归档 / 自动路由切换 均被拒绝', () => {
  const a = validateConfig({ reasoning: { signature_to_ui: true } });
  assert.ok(a.issues.some((i) => i.message.includes('signature_to_ui')));
  const b = validateConfig({ reasoning: { archive_to_mariposa: true } });
  assert.ok(b.issues.some((i) => i.message.includes('archive_to_mariposa')));
  const c = validateConfig({ runtime: { automatic_flag_switch: true } });
  assert.ok(c.issues.some((i) => i.message.includes('automatic_flag_switch')));
});

test('YAML 不支持的内联非空列表 → 报错而非静默', () => {
  assert.throws(() => parseYaml('a: [1, 2]'), /内联非空列表/);
});
