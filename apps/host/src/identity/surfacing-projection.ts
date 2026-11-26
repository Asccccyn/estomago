/** Select verbatim facts from the approved identity text for the current recall decision. */
export function projectIdentityFacts(approvedText: string, dialogue: string): string[] {
  const mentionsAge = /\d{1,3}\s*岁|年龄|年纪|几岁|多大/.test(dialogue);
  const result: string[] = [];
  for (const part of approvedText.match(/[^。！？；\r\n]+[。！？；]?/g) ?? []) {
    const sentence = part.trim();
    if (!sentence || sentence.length > 160) continue;
    const named = /姓名|本名|昵称|别名|小名|称呼|名叫/.test(sentence);
    const explicitNames = named
      ? [...sentence.matchAll(/(?:姓名|本名|昵称|别名|小名|称呼|名叫)\s*(?:是|为|[:：])?\s*([\p{L}\p{N}_·-]{2,16})(?=$|[\s、，,。！？；])/gu)].map(match => match[1]!)
      : [];
    const quotedNames = named
      ? [...sentence.matchAll(/[「『“]([\p{L}\p{N}_·-]{2,16})[」』”]/gu)].map(match => match[1]!)
      : [];
    const containsMention = [...explicitNames, ...quotedNames].some(name => dialogue.includes(name));
    if ((mentionsAge && /\d{1,3}\s*岁/.test(sentence)) || containsMention) {
      result.push(sentence);
      if (result.length === 4) break;
    }
  }
  return result;
}
