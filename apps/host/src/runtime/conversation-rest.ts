// The owner's standing rest decision: she said she is going to sleep or ended
// the chat to rest, and later that she is back. Only her own formally accepted
// input or an explicit control sets or clears it; model replies, tools, recalled
// history and reserved notes never do.
//
// This reads explicit phrases. It is not a classifier and calls no model. A
// statement is an opening or closing clause that names sleeping, resting or
// being back, is about the speaker herself, and carries no cue that makes it a
// question, a remark about the feature or another person, a report of an earlier
// time, a negation, or a plan for later.

export type RestIntent = 'rest' | 'resume';

const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|^.{0,3}>.*$/gm;
const REST_PHRASE = /(?<![你您])晚安|(?<![你您])(?:先睡|要睡|得睡|该睡|去睡|睡了|睡吧|睡觉了|睡觉去|准备睡|想睡了)|(?<![你您])(?:先休息|要休息|去休息|休息了|休息吧)|我(?:很|好|太|真)?困|好困|太困|困死|困到|good ?night|going ?to ?bed|off ?to ?bed/i;
const RESUME_PHRASE = /(?<![你您他她它梦])醒了|(?<![你您他她它还没不])起床|(?<![你您他她它还没不])起来了|(?<![你您他她它还没])回来了|回来啦|我(?:又|来|已经)?上线了|早安|早上好|午安|(?<![你您])(?:继续聊|接着聊|接着说|继续说)|(?:我们|咱们)继续|good ?morning|i ?(?:am|m) ?(?:back|awake)/i;
const QUESTION_CLAUSE = /\?$|吗|好不好|行不行|可不可以|要不要|能不能|会不会|是不是/;
const REST_BLOCKED = /为什么|为何|怎么|什么|哪个|哪些|谁|几点|多久|功能|设置|规则|这个词|这两个字|这句|那条|那段|含义|意思|[他她它](?:说|跟|给|要)|(?:不|没|未|非|别)(?:想|要|是|是在|打算|准备|愿意|敢|能|会|肯|许|准|用)?(?:跟|对|和|给)?(?:我|你)?(?:说|道|讲)?晚安|(?:不要|别|不许|不准|不用)(?:跟|对|和|给)?(?:我)?(?:你)?(?:说|道|讲)|说(?:过|了)晚安|道(?:过|了)晚安|昨天|昨晚|前天|上次|上回|之前|早已|已经|每天|天天|总是|老是|经常|那次|当时|那时候|刚才|午觉|午睡|睡了个|睡了一|等会|等下|待会|一会儿|一会|晚点|稍后|过会|再睡|早点睡|不睡|不想睡|还没睡|不困|还想|如果|要是|晚安(?:歌|曲|故事|铃|音|吻|电台|文案|句子|语录|图片|表情|包)/;
const RESUME_BLOCKED = /什么时候醒|几点醒|多久醒|会不会醒|醒了没|起来没|回来了吗|回来了没|回来了没有|说(?:过|了)|道(?:过|了)|提到|讨论|昨天|昨晚|前天|上次|之前|早已|每天|天天|明天|明早|半夜|凌晨|又醒|惊醒|吵醒|梦|没醒|没起|不想起|起不来|没回|不回|叫我|喊我|叫醒|闹钟|提醒我|等我醒|等我起|等你醒|等你起/;
/** A longer message only states rest in its opening or closing clause. */
const SHORT = 30;
/** A clause about another person or pet is not a statement about the speaker. */
const ADDRESSED_TO_OTHER = /^(?:[你您他她它]|(?:我家|我的|咱们家|家里的)?(?:宝宝|孩子|娃|女儿|儿子|小朋友|小家伙|婴儿|猫|小猫|猫咪|狗|小狗|宠物|爸|妈|父母|爷爷|奶奶|外公|外婆|哥哥|姐姐|弟弟|妹妹|家人|家里人|全家人|室友|同学|同事|朋友|老板|客人|邻居|别人|大家|有人|没人))/;
/** Continuing the current conversation right now (e.g. whispering because the baby fell asleep) is not going to sleep. */
const ACTIVE_CHAT_NOW = /(?:轻声|小声|偷偷|悄悄|再陪我|陪我)(?:聊|说)|(?<!明天|明早|改天|下次|等会|等下|待会|晚点|回头|醒了|睡醒)(?:继续|接着)(?:聊|说)/;

function clauses(text: string): string[] {
  return [...text.normalize('NFKC').replace(/['’]/g, '')
    .replace(QUOTED, match => match.replace(/[^\n]/g, ' '))
    .replace(/\?+/g, '?\n')
    .split(/(?!\?)[\p{P}\p{S}\n]+/u)]
    .map(clause => clause.replace(/ +/g, ''))
    .filter(Boolean);
}

/** What the owner's own message states about resting, or null when it states nothing. */
export function detectRestIntent(text: unknown): RestIntent | null {
  if (typeof text !== 'string') return null;
  const parts = clauses(text);
  if (!parts.length) return null;
  const total = parts.reduce((length, clause) => length + clause.replace(/\?$/g, '').length, 0);
  const states = (phrase: RegExp, blocked: RegExp): boolean => {
    const isStatement = (clause: string): boolean =>
      !QUESTION_CLAUSE.test(clause) && !ADDRESSED_TO_OTHER.test(clause) && phrase.test(clause) && !blocked.test(clause);
    return total <= SHORT ? parts.some(isStatement) : isStatement(parts[0]!) || isStatement(parts.at(-1)!);
  };
  if (states(RESUME_PHRASE, RESUME_BLOCKED)) return 'resume';
  if (parts.some(clause => !QUESTION_CLAUSE.test(clause) && ACTIVE_CHAT_NOW.test(clause))) return null;
  if (states(REST_PHRASE, REST_BLOCKED)) return 'rest';
  return null;
}
