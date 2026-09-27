// 极小 YAML 子集解析器：只支持 estomago.example.yaml 实际用到的语法。
// 支持：注释、2 空格缩进嵌套 map、块列表（- 标量）、内联空列表 []、
//       单引号字符串、null/true/false、整数/小数。
// 不支持（遇到即报错，不静默忽略）：锚点、多行字符串、内联非空列表/对象、Tab 缩进。
// 设计取舍：estómago 不引入 npm 依赖（Node 22 原生运行），配置面保持小而可校验。

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

class YamlError extends Error {
  readonly lineNo: number;
  constructor(message: string, lineNo: number) {
    super(`YAML line ${lineNo}: ${message}`);
    this.lineNo = lineNo;
  }
}

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

function preprocess(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\n/);
  for (let i = 0; i < raw.length; i++) {
    let s = raw[i];
    // 注释：行首 # 或空白后 #（引号内不算——本子集值里不含 # 后注释歧义时用引号）
    const hashIdx = s.indexOf('#');
    if (hashIdx >= 0) {
      const before = s.slice(0, hashIdx);
      const quoteCount = (before.match(/'/g) || []).length;
      if (quoteCount % 2 === 0) s = before;
    }
    if (/^\s*$/.test(s)) continue;
    if (s.includes('\t')) throw new YamlError('tab 缩进不允许', i + 1);
    const indent = s.length - s.trimStart().length;
    out.push({ indent, text: s.trim(), lineNo: i + 1 });
  }
  return out;
}

function parseScalar(raw: string, lineNo: number): string | number | boolean | null {
  const t = raw.trim();
  if (t === 'null' || t === '~' || t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1);
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (/^:|\s:/.test(t)) throw new YamlError(`不支持内联 map：${t}`, lineNo);
  return t;
}

function isListItem(text: string): boolean {
  return text.startsWith('- ') || text === '-';
}

export function parseYaml(src: string): { [k: string]: YamlValue } {
  const lines = preprocess(src);
  if (lines.length === 0) return {};
  const firstIndent = lines[0]!.indent;
  const result = parseMap(lines, 0, firstIndent, { i: 0 });
  if (result.end < lines.length) {
    throw new YamlError(`多余的顶层内容：${lines[result.end]!.text}`, lines[result.end]!.lineNo);
  }
  return result.value;
}

function parseMap(
  lines: Line[],
  start: number,
  mapIndent: number,
  pos: { i: number },
): { value: { [k: string]: YamlValue }; end: number } {
  const value: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < mapIndent) break;
    if (line.indent > mapIndent) throw new YamlError(`缩进不一致（期望 ${mapIndent}，得到 ${line.indent}）`, line.lineNo);
    if (isListItem(line.text)) break;
    const m = /^([A-Za-z0-9_]+|'[^']+')\s*:(.*)$/.exec(line.text);
    if (!m) throw new YamlError(`无法解析键值行：${line.text}`, line.lineNo);
    const key = m[1]!.startsWith("'") ? m[1]!.slice(1, -1) : m[1]!;
    const restRaw = m[2]!.trim();
    if (restRaw === '') {
      // 值在更深的缩进（map 或列表），或 null（下一行不更深则为 null）
      const next = lines[i + 1];
      if (next && next.indent > mapIndent) {
        if (isListItem(next.text)) {
          const list = parseList(lines, i + 1, next.indent, pos);
          value[key] = list.value;
          i = list.end;
        } else {
          const sub = parseMap(lines, i + 1, next.indent, pos);
          value[key] = sub.value;
          i = sub.end;
        }
      } else {
        value[key] = null;
        i += 1;
      }
    } else if (restRaw === '[]') {
      value[key] = [];
      i += 1;
    } else if (restRaw.startsWith('[')) {
      throw new YamlError('不支持内联非空列表，请用块列表（- 项）', line.lineNo);
    } else {
      value[key] = parseScalar(restRaw, line.lineNo);
      i += 1;
    }
  }
  pos.i = i;
  return { value, end: i };
}

function parseList(lines: Line[], start: number, listIndent: number, pos: { i: number }): { value: YamlValue[]; end: number } {
  const value: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent !== listIndent || !isListItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') throw new YamlError('列表项为空', line.lineNo);
    if (rest.startsWith("'") || !rest.includes(':')) {
      value.push(parseScalar(rest, line.lineNo));
      i += 1;
    } else {
      throw new YamlError('不支持列表项内嵌 map', line.lineNo);
    }
  }
  pos.i = i;
  return { value, end: i };
}
