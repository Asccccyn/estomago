// The owner's standing rest decision: she said she is going to sleep or ended
// the chat to rest. Only her own formally accepted input or an explicit control
// sets or clears it; model replies, tools, recalled history and reserved notes never do.
//
// In v2.1, trivial unambiguous expressions take an explainable local fast-path,
// while colloquial, negated, quoted, third-party, or ambiguous rest-cued messages
// are routed to the independent Sol rest judge when configured (never by endlessly
// expanding a keyword list).

import { addCalendarDays } from './keepwarm-sleep.ts';

export type RestIntent = 'rest' | 'resume';
export type RestKind = 'sleep' | 'nap_or_wait';
export type RestRecoveryMode = 'morning_0800' | 'next_user_message';

export type LocalRestPrecheck =
  | { kind: 'clear_rest'; restKind: RestKind }
  | { kind: 'clear_not_rest' }
  | { kind: 'needs_sol' };

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|^.{0,3}>.*$/gm;
const REST_PHRASE = /(?<![你您])晚安|(?<![你您])(?:先睡|要睡|得睡|该睡|去睡|睡了|睡吧|睡觉了|睡觉去|准备睡|想睡了)|(?<![你您])(?:先休息|要休息|去休息|休息了|休息吧)|我(?:很|好|太|真)?困|好困|太困|困死|困到|good ?night|going ?to ?bed|off ?to ?bed/i;
// 2026-11-27 裁定退役：短暂打盹/等我回来（原 NAP_OR_WAIT_PHRASE）不再构成休息意图；
// 快路径由 CLEAR_NAP_WAIT_EXACT 直接判 not_rest，语义判断交给 Sol 的新口径提示词。
const NAP_PAST_BLOCKED = /(?<!去|先|要|准备)午睡了|睡了(?:个)?午觉|睡了一[会儿觉]|已经睡|刚才|昨天|昨晚|下午睡了|现在精神/;
/** 2026-11-27 裁定：子句里带明确小睡/打盹/等我回来时，共享字面的正式睡眠短语
 *  （如"午睡了"命中"睡了"、"去睡个午觉"命中"去睡"）不再构成休息意图；
 *  纯正式睡眠（"晚安""去睡了"）不受影响。 */
const NAP_INTENT_BLOCKED = /午睡|睡午觉|睡个午觉|眯一[会儿下]|小睡|打个?盹|补个?觉|等我(?:回来|找你)|待我回来/;
const RESUME_PHRASE = /(?<![你您他她它梦])醒了|(?<![你您他她它梦])醒来|还醒着|醒着呢|(?<![你您他她它还没不])起床|(?<![你您他她它还没不])起来了|(?<![你您他她它还没])回来了|回来啦|我(?:又|来|已经)?上线了|早安|早上好|午安|(?<![你您])(?:继续聊|接着聊|接着说|继续说)|(?:我们|咱们)继续|good ?morning|i ?(?:am|m) ?(?:back|awake)/i;
const QUESTION_CLAUSE = /\?$|吗|好不好|行不行|可不可以|要不要|能不能|会不会|是不是/;
const FUTURE_TIME_MODIFIER = /明天|明早|改天|下次|等会|等下|待会|晚点|回头|醒了|睡醒|过会/;
const REST_BLOCKED = /为什么|为何|怎么|什么|哪个|哪些|谁|几点|多久|功能|设置|规则|这个词|这两个字|这句|那条|那段|含义|意思|[他她它](?:说|跟|给|要)|(?:不|没|没有|未|非|别)(?:想|要|是|是在|打算|准备|愿意|敢|能|会|肯|许|准|用)?(?:跟|对|和|给)?(?:我|你)?(?:说|道|讲|提)(?:过|了)?.*?(?:晚安|睡|休息|困)|(?:不要|别|不许|不准|不用)(?:跟|对|和|给)?(?:我)?(?:你)?(?:说|道|讲)|说(?:过|了)晚安|道(?:过|了)晚安|昨天|昨晚|前天|上次|上回|之前|早已|已经|每天|天天|总是|老是|经常|那次|当时|那时候|刚才|睡了个|睡了午觉|睡了一|等会|等下|待会|一会儿|一会|晚点|稍后|过会|再睡|早点睡|不睡|不想睡|还没睡|没睡|不困|还想|如果|要是|晚安(?:歌|曲|故事|铃|音|吻|电台|文案|句子|语录|图片|表情|包)/;
const RESUME_BLOCKED = /什么时候醒|几点醒|多久醒|会不会醒|醒了没|起来没|回来了吗|回来了没|回来了没有|说(?:过|了)|道(?:过|了)|提到|讨论|昨天|昨晚|前天|上次|之前|早已|每天|天天|明天|明早|改天|下次|半夜|凌晨|又醒|惊醒|吵醒|梦|没醒|没起|不想起|起不来|没回|不回|叫我|喊我|叫醒|闹钟|提醒我|等我醒|等我起|等你醒|等你起/;
/** A longer message only states rest in its opening or closing clause. */
const SHORT = 30;
/** A clause about another person or pet is not a statement about the speaker. */
const ADDRESSED_TO_OTHER = /^(?:[你您他她它]|(?:我家|我的|咱们家|家里的)?(?:宝宝|孩子|娃|女儿|儿子|小朋友|小家伙|婴儿|猫|小猫|猫咪|狗|小狗|宠物|爸|妈|父母|爷爷|奶奶|外公|外婆|哥哥|姐姐|弟弟|妹妹|家人|家里人|全家人|室友|同学|同事|朋友|老板|客人|邻居|别人|大家|有人|没人))/;
/** Continuing the current conversation right now (e.g. whispering because the baby fell asleep) is not going to sleep.
 *  Future continuations ("明天再继续聊", "明早接着说") are explicitly excluded. */
const ACTIVE_CHAT_NOW_CORE = /(?:轻声|小声|偷偷|悄悄|再陪我|陪我)(?:聊|说)|(?:继续|接着)(?:聊|说)/;

/** Clear, short, single-intent direct statements handled on the explainable local fast-path. */
const CLEAR_SLEEP_EXACT = /^(?:(?:好[啦呀的]?|嗯+|那)?(?:char)?晚安(?:[，, ]*(?:好梦|爱你|我?(?:先|要|去|准备)?睡(?:觉)?(?:了|啦|去)?))?|我?(?:现在)?(?:真的)?(?:先|要|去|准备)?睡(?:觉)?(?:了|啦|去)|我?(?:先)?去休息(?:了|啦)?|good ?night|i'?m going to bed)[！!。.~～\s]*$/i;
const CLEAR_NAP_WAIT_EXACT = /^(?:我?(?:先|要|去|准备)?(?:午睡|睡午觉|睡个午觉)(?:了|去|啦|一会[儿]?)|(?:先)?等我回来(?:再聊)?)[！!。.~～\s]*$/;

/** Any semantic cue that warrants Sol semantic interpretation rather than a local guess. */
export const SEMANTIC_REST_CUE = /晚安|睡|休息|歇一[会儿下]?|先歇|去歇|歇了|歇着|打个?盹|补个?觉|困|撑不住|睁不开|扛不住|熬不住|累死了|好累|太累|没精力|先到这|先这样|先不聊|不聊了|明天(?:聊|说|见|再)|明早|改天(?:聊|说)|晚点(?:聊|说)|回头(?:聊|说)|眯一|眯会|合眼|闭眼|躺[下会]|关灯|上床|去修|去忙|下线|先撤|先下了|先退|走了|等我回来|等我找你|醒着|醒来|睡醒|good ?night|sleep|bed|tired|nap|rest/i;

function clauses(text: string): string[] {
  return [...text.normalize('NFKC').replace(/['’]/g, '')
    .replace(QUOTED, match => match.replace(/[^\n]/g, ' '))
    .replace(/\?+/g, '?\n')
    .split(/(?!\?)[\p{P}\p{S}\n]+/u)]
    .map(clause => clause.replace(/ +/g, ''))
    .filter(Boolean);
}

function isActiveChatNow(clause: string): boolean {
  if (QUESTION_CLAUSE.test(clause)) return false;
  if (!ACTIVE_CHAT_NOW_CORE.test(clause)) return false;
  // "明天再继续聊" / "醒了接着聊" refers to resuming later, not continuing right now.
  if (FUTURE_TIME_MODIFIER.test(clause)) return false;
  return true;
}

/** Explainable local pre-check separating unambiguous local fast-path cases from
 *  messages that require Sol semantic rest-intent judgment. */
export function classifyRestLocally(text: unknown): LocalRestPrecheck {
  if (typeof text !== 'string') return { kind: 'clear_not_rest' };
  const normalized = text.normalize('NFKC').trim();
  if (!normalized) return { kind: 'clear_not_rest' };
  // 2026-11-27 裁定：白天已恢复聊天后的短暂打盹/午睡/等我回来不再暂停心跳
  // （短暂离开≠把心跳关到"等下一次出现"）；明确短句走本地快路径直接按未休息处理。
  if (CLEAR_NAP_WAIT_EXACT.test(normalized) && !NAP_PAST_BLOCKED.test(normalized)) {
    return { kind: 'clear_not_rest' };
  }
  if (CLEAR_SLEEP_EXACT.test(normalized)) {
    return { kind: 'clear_rest', restKind: 'sleep' };
  }
  if (!SEMANTIC_REST_CUE.test(normalized)) {
    return { kind: 'clear_not_rest' };
  }
  return { kind: 'needs_sol' };
}

/** Classify whether a confirmed rest decision recovers at 08:00 (normal night rest:
 *  18:00:00–01:59:59 Asia/Shanghai) or waits for the owner's next new message
 *  (all-nighter sleep >= 02:00:00, or daytime rest).
 *  2026-11-27 裁定后新休息决定只余 sleep；nap_or_wait 分支仅服务既有落库行的
 *  恢复推断，不再产生新决策。 */
export function classifyRestRecoveryMode(acceptedAtMs: number, restKind: RestKind): {
  mode: RestRecoveryMode;
  morningDate: string | null;
} {
  if (restKind === 'nap_or_wait') {
    return { mode: 'next_user_message', morningDate: null };
  }
  const sh = new Date(acceptedAtMs + SHANGHAI_OFFSET_MS);
  const hour = sh.getUTCHours();
  const dateStr = sh.toISOString().slice(0, 10);
  if (hour >= 18) {
    return { mode: 'morning_0800', morningDate: addCalendarDays(dateStr, 1) };
  }
  if (hour < 2) {
    return { mode: 'morning_0800', morningDate: dateStr };
  }
  // 02:00:00 through 17:59:59 Asia/Shanghai: cancels today's unconsumed 08:00 and waits for next user message.
  return { mode: 'next_user_message', morningDate: null };
}

/** Local fallback rest-intent detector (used when Sol is not configured and by local unit checks).
 *  Fixes R4: future-modified continuations ("晚安，明天再继续聊") and negated speech reports
 *  ("我没说我睡了，我还醒着呢") are handled cleanly.
 *  2026-11-27 裁定：短暂打盹/午睡/等我回来（NAP_OR_WAIT_PHRASE）不再是休息意图——
 *  只有正式睡眠短语（REST_PHRASE）构成 rest。 */
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
  if (parts.some(isActiveChatNow)) return null;
  if (states(REST_PHRASE, new RegExp(`${REST_BLOCKED.source}|${NAP_INTENT_BLOCKED.source}`))) return 'rest';
  return null;
}

/** 2026-11-27 裁定后新休息决定一律按正式睡眠处理（短暂打盹不再产生休息决定）；
 *  返回值仅影响恢复模式推断，见 classifyRestRecoveryMode。 */
export function detectRestKindLocally(_text: unknown): RestKind {
  return 'sleep';
}

const UNCERTAIN_PERSONAL_REST_CUE = /(?<![不没])(?:困|累|撑不住|扛不住|熬不住|睁不开|歇一[会儿下]?|先歇|去歇|眯一|眯会|合眼|闭眼|打个?盹|补个?觉|先到这|先这样|先不聊|不聊了|先撤|先下了|先退|躺[下会])|说不准|不确定|不知道要不要睡|可能(?:要|会)?睡|也许(?:要|会)?睡/;
const EXPLICIT_AWAKE_OR_NEGATED_SLEEP = /睡不着|失眠|不想睡|还不睡|没睡着|不睡了|没困|不困/;

/** Conservative local fallback used ONLY when a message requires Sol (`needs_sol`)
 *  but Sol is not configured. Ambiguous personal rest cues yield 'uncertain' (preserving
 *  existing rest/recovery state identically to Sol 503/timeout/uncertain) rather than
 *  silently clearing an active rest. */
export function classifyRestFallbackWithoutSol(text: unknown): 'rest' | 'not_rest' | 'uncertain' {
  if (typeof text !== 'string') return 'not_rest';
  const intent = detectRestIntent(text);
  if (intent === 'rest') return 'rest';
  if (intent === 'resume') return 'not_rest';
  const parts = clauses(text);
  if (!parts.length) return 'not_rest';
  if (parts.some(isActiveChatNow)) return 'not_rest';
  const normalized = text.normalize('NFKC');
  if (EXPLICIT_AWAKE_OR_NEGATED_SLEEP.test(normalized) && !UNCERTAIN_PERSONAL_REST_CUE.test(normalized)) {
    return 'not_rest';
  }
  const hasAmbiguousCue = parts.some(clause =>
    !ADDRESSED_TO_OTHER.test(clause)
    && !REST_BLOCKED.test(clause)
    && UNCERTAIN_PERSONAL_REST_CUE.test(clause),
  );
  return hasAmbiguousCue ? 'uncertain' : 'not_rest';
}
