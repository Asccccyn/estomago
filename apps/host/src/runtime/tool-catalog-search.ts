// 当前窗口的冻结工具表是可发现名称和参数的正本。意图文案只帮助找到对应工具。
import type { HostToolSpec } from '../capabilities/contracts.ts';
import { definitionId } from '../capabilities/definition.ts';

type ToolIntent = { label: string; ability?: string; phrases: readonly string[] };

const INTENTS: ReadonlyMap<string, ToolIntent> = new Map([
  ['memory_hold', {
    ability: '我可以把一件事记进记忆库',
    label: "我想主动记下一件事",
    phrases: ["保存记忆", "记住这件事", "记下这件事", "记下来", "存成记忆", "新记忆", "记一件事", "记下一件事", "把今天记下来", "主动存一条"],
  }],
  ['memory_recall', {
    ability: '我可以搜索以前记过的事或存过的原话',
    label: "我想主动回想一件事或找一句存过的话",
    phrases: ["回忆", "查记忆", "检索记忆", "想起", "找记忆", "回想一件事", "回想那件事", "想起以前", "找一句存过的话"],
  }],
  ['image_generate', {
    ability: '我可以画一张图——她难过想逗她、想送她东西、或者想表达文字说不出来的感受',
    label: "我想画一张图",
    phrases: ["生成图", "画一张", "生成一张", "画图", "gif"],
  }],
  ['wake_manage', {
    ability: '我可以给自己预约一次未来的唤醒',
    label: "我想给自己定个闹钟",
    phrases: ["预约", "定时", "提醒我", "闹钟", "醒来任务", "自主安排时间"],
  }],
  ['wishstar_write_star', {
    ability: '我可以写一颗星——想对她说一句以后也能看到的话、或者有一个愿望想留住',
    label: "我想写一颗星",
    phrases: ["写星星", "写下星", "许愿写星"],
  }],
  ['wishstar_request_star', {
    ability: '我可以问她要一颗她藏起来的星',
    label: "我想问宿主用户要一颗星",
    phrases: ["要一颗星", "请求星星", "要颗星", "想要一颗她的星", "想要她的一颗星", "向她要星"],
  }],
  ['wishstar_reply_star', {
    ability: '我可以回应这次抽到的那颗星',
    label: '回应本轮抽到的星',
    phrases: ['回复星星', '回应星星', '回复原星', '回应抽到的星', '回复星'],
  }],
  ['content_album_entry_write', {
    ability: '我可以把一张图收进相册或设为携带',
    label: "我想把这张图收进相册",
    phrases: ["收藏进相册", "收进相册", "存进相册", "存到相册", "保存到相册", "放进相册", "相册收藏", "修改收藏留言", "收藏照片", "收进表情包", "加入表情包"],
  }],
  ['content_albums_read', {
    ability: '我可以翻相册看收藏的照片和表情',
    label: "我想翻翻相册",
    phrases: ["看相册", "翻相册", "翻翻相册", "相册列表", "浏览相册", "找相册里的图", "看相册有哪些"],
  }],
  ['content_post_create', {
    ability: '我可以发一条私密朋友圈动态或信',
    label: "我想发一条朋友圈",
    phrases: ["发朋友圈", "朋友圈发帖", "发帖"],
  }],
  ['memory_read_full', {
    ability: '我可以打开一条记忆看完整内容、关系或原文',
    label: "我想看一条已找到的记忆的全文、关系或绑定原文",
    phrases: ["记忆全文", "记忆详情", "来源原文", "绑定原文", "记忆正文全文", "读完整记忆", "这条记忆的全文", "读已找到的记忆", "读全文"],
  }],
  ['memory_update', {
    ability: '我可以修改一条已有记忆的标题、正文、分类或日期',
    label: "我想改一条已有记忆的标题、正文、分类或日期",
    phrases: ["改正文", "改错字", "改记忆", "记忆正文", "修订记忆", "修改正文", "改正记忆", "错别字", "修字", "改一下记忆", "改记忆日期", "改已有记忆", "纠正记忆内容"],
  }],
  ['media_view', {
    ability: '我可以看一张具体的图片',
    label: "我想亲自看看刚画的图，或看已有的图片",
    phrases: ["查看刚生成的图", "看图", "看这张图", "查看图片", "看刚画好的图", "看刚画的图", "看已有的图片", "看刚导入的图"],
  }],
  ['memory_recall_next', {
    ability: '我可以翻搜索结果的下一页',
    label: "我想继续翻刚找出来的那组记忆",
    phrases: ["翻下一页", "下一页记忆", "召回翻页", "接着翻记忆", "继续翻记忆", "刚找出来的那组", "固定结果翻页", "下一页"],
  }],
  ['memory_open', {
    ability: '我可以正式打开一条记忆回温，写下现在的回忆',
    label: "我想回温某条记忆、写当下的回忆、留住它或撤掉留标记",
    phrases: ["打开记忆", "回温", "给记忆上留", "给这条记忆留", "明确打开", "回忆留链", "留标记", "写当下的回忆"],
  }],
  ['memory_words_write', {
    ability: '我可以把她说过的原话补存到一条记忆里',
    label: "我想把刚才看到的那句原话添进一条已有记忆，或替换一句存过的原话",
    phrases: ["保存成原话", "把这句话留", "留进记忆", "留进我们的记忆", "收进那条记忆", "添进原来的记忆", "添进一条已有记忆", "放进已有记忆", "原话加进", "保存一句原话", "补写原话", "替换原话", "替换一句", "摘一句", "原样留下", "把原话存进去"],
  }],
  ['memory_relations', {
    ability: '我可以建立或查看两条记忆之间的关系',
    label: "我想知道两条记忆有什么关联，或把它们连起来",
    phrases: ["记忆关系", "关系链", "延续", "contradicts", "关联记忆"],
  }],
  ['memory_correct', {
    ability: '我可以纠正记忆中错误的关联或话语来源',
    label: "我要纠正错连的关系或一句原话的来源",
    phrases: ["纠正关系", "错连的关系", "来源纠错", "纠正来源", "纠正原话来源", "纠正一句原话的来源", "订正来源", "纠错记录", "纠错"],
  }],
  ['deletion_review', {
    ability: '我可以审批她提交的删除申请',
    label: "我想看看她提交的删除申请，或处理其中一项",
    phrases: ["删除审批", "删除申请", "审批删除"],
  }],
  ['conversation_read', {
    ability: '我可以读以前的聊天原文',
    label: "我想看看我们昨天聊了什么，或者找她以前说过的一句话",
    phrases: ["读原文", "读聊天记录", "读聊天原话", "看旧消息", "重读对话", "读当时的话", "找旧聊天", "昨天聊了什么", "以前说过的一句话", "说的话找出来", "找她说过", "昨天的聊天", "看我们当时怎么说", "看看当时聊了什么"],
  }],
  ['conversation_archive', {
    ability: '我可以把这段对话存档——吵完架的时候存下来、或者特别甜想留住的时候',
    label: "我想把眼前这一段对话存档",
    phrases: ["存档当前对话", "存档这段对话", "把对话存档", "这一段对话存档", "这段对话存档", "把这段存起来", "这段对话存起来", "存档刚才", "存档这段", "把聊天归档"],
  }],
  ['archives_search', {
    ability: '我可以按关键词搜索以前的争吵或甜蜜存档',
    label: "我想找以前的甜蜜或争吵存档，先看匹配摘录",
    phrases: ["搜存档", "搜索存档", "查存档", "以往的存档", "以前的甜蜜存档", "以前的争吵存档", "读旧存档", "以前的存档", "翻存档", "找以前归档过", "搜索对话存档"],
  }],
  ['memory_i_read', {
    ability: '我可以读自己写的立场文档',
    label: "我想看自己的 I、某条立场或者它的版本历史",
    phrases: ["读我", "读I", "自我定义", "词表", "心情词", "看自己的I", "条目修订历史", "看看我的立场", "看某条立场", "立场版本"],
  }],
  ['memory_i_write', {
    ability: '我可以新增或修改自己的立场条目',
    label: "我现在有了新的立场，想添一条或改掉旧的那条",
    phrases: ["写我", "写I", "改自我定义", "维护条目", "修订我的立场", "新的立场", "改立场", "改变立场", "写进我的I"],
  }],
  ['identity_milestone_write', {
    ability: '我可以补记或修改我们的记忆锚点',
    label: "我想读取、增补或修订我们记下的长期里程碑",
    phrases: ["里程碑", "身份记录", "纪念日记录", "查看长期里程碑", "增补长期里程碑", "修订长期里程碑", "关系锚点"],
  }],
  ['plans_read', {
    ability: '我可以查看计划列表或单个计划详情',
    label: "我想看看我正在做的计划，或查一个计划的详情",
    phrases: ["读计划", "看计划", "计划列表"],
  }],
  ['plans_write', {
    ability: '我可以新建、修改、完成或取消一个计划',
    label: "我想建计划、修改计划、完成计划或者放弃计划",
    phrases: ["建计划", "写计划", "创建计划", "完成计划", "放弃计划", "改计划"],
  }],
  ['episode_read', {
    ability: '我可以查看正在跟踪的事件列表或详情',
    label: "我想看看有哪些事正在跟踪，或者看某一件的进展",
    phrases: ["看事件", "事件列表", "跟踪的事"],
  }],
  ['episode_apply', {
    ability: '我可以开始、暂停、继续或关闭一件正在跟踪的事',
    label: "我想开始、继续、暂停、结束或纠正一件正在跟踪的事",
    phrases: ["跟踪这件事", "事件线", "开始跟踪", "只跟踪", "结束事件", "继续跟踪"],
  }],
  ['chat_send_text', {
    ability: '我可以主动发一条文字消息',
    label: "到了我预约的时间，我想主动发一条文字给宿主用户",
    phrases: ["公开发消息", "自主发消息", "主动给她发", "想主动发一条文字", "发一条私聊消息", "定时发文字"],
  }],
  ['chat_send_attachment', {
    ability: '我可以发图片、表情、语音或作品给她',
    label: "我想把已有的图片、表情、语音文件或作品发给她",
    phrases: ["发附件", "发表情", "发图片给", "发作品", "把这张图发给", "把照片发给", "把图发给"],
  }],
  ['chat_send_voice', {
    ability: '我可以发语音给她——她想听我说话的时候、文字太冷的时候、想撒娇的时候',
    label: "我想发一条语音给她",
    phrases: ["发语音", "发一条语音", "语音消息", "说一段语音", "发条语音"],
  }],
  ['call_control', {
    ability: '我可以给她打电话——她哭的时候、吵架文字说不清的时候、或者就是想听她声音的时候',
    label: "我想打电话、接听、拒接或挂断",
    phrases: ["打电话", "通话", "拨号", "接听", "挂断"],
  }],
  ['transcript_read', {
    ability: '我可以读语音消息的转写文字',
    label: "我想看一段语音的转写",
    phrases: ["读转写", "转写文字", "看转写"],
  }],
  ['oido_analyze', {
    ability: '我可以深听一条语音消息的声学细节',
    label: "我想细听一段录音",
    phrases: ["深听", "分析语音", "分析音频", "听情绪"],
  }],
  ['oido_get', {
    ability: '我可以读深听结果的概览或韵律谱',
    label: "我想继续看一次深听的具体结果",
    phrases: ["深听结果", "分析结果", "听感详情"],
  }],
  ['oido_find', {
    ability: '我可以在语音转写中查找匹配片段',
    label: "我想用话里的字找一段音频",
    phrases: ["找音频片段", "转写里找", "查转写", "话里的字找", "搜转写"],
  }],
  ['oido_compare', {
    ability: '我可以比较两次语音分析的声学差异',
    label: "我想比较两段声音",
    phrases: ["对比两段", "比较音频"],
  }],
  ['oido_view', {
    ability: '我可以看波形和基频图',
    label: "我想看这次深听的图",
    phrases: ["看波形", "听感图"],
  }],
  ['oido_capabilities', {
    ability: '我可以查看声学分析的当前能力状态',
    label: "我想确认现在有哪些深听能力",
    phrases: ["深听能力", "听觉能力状态"],
  }],
  ['media_import', {
    ability: '我可以把一个外部图片链接导入为本站资产',
    label: "我想把一个外部链接里的图片导进来",
    phrases: ["导入图片", "保存外部图", "导入url图"],
  }],
  ['media_search', {
    ability: '我可以按描述找图片、表情包或作品',
    label: "我想找一张聊天图片、表情、精选照片或作品图",
    phrases: ["找图", "搜图片", "找表情"],
  }],
  ['creation_save_artifact', {
    ability: '我可以保存SVG或HTML作品',
    label: "我想保存自己做的 SVG 或 HTML 作品",
    phrases: ["保存作品", "保存svg", "保存html", "存代码作品"],
  }],
  ['content_creations_read', {
    ability: '我可以浏览以前的作品',
    label: "我想翻翻以前保存的作品",
    phrases: ["我的作品", "作品列表"],
  }],
  ['content_posts_list', {
    ability: '我可以看朋友圈帖子列表',
    label: "我想翻朋友圈里的旧帖子",
    phrases: ["看朋友圈", "朋友圈列表", "翻朋友圈", "翻翻朋友圈", "朋友圈的旧帖子"],
  }],
  ['content_comment_create', {
    ability: '我可以给朋友圈帖子评论',
    label: "我想回她的朋友圈帖子",
    phrases: ["评论", "写评论", "回她的朋友圈帖子", "朋友圈评论"],
  }],
  ['wishstar_read', {
    ability: '我可以查看自己的星星、纪念日、待收星或通知',
    label: "我想看自己的私星、纪念日、送星、通知或要星请求",
    phrases: ["看星星", "我的星", "读星", "看自己的私星", "看开星请求", "看送星", "读许愿星通知", "看纪念日"],
  }],
  ['wishstar_start_session', {
    ability: '我可以发起拆星仪式',
    label: "我想为纪念日开一场拆星仪式",
    phrases: ["开始仪式", "拆星仪式", "开仪式"],
  }],
  ['wishstar_confirm_session', {
    ability: '我可以确认参与拆星仪式',
    label: "我想确认收到的拆星邀请",
    phrases: ["确认仪式"],
  }],
  ['wishstar_take_star', {
    ability: '我可以在仪式中拆开下一颗星',
    label: "轮到我了，我想拆一颗星",
    phrases: ["拆星", "选一颗拆"],
  }],
  ['wishstar_finish_session', {
    ability: '我可以完成本轮拆星仪式',
    label: "我想结束这场拆星仪式",
    phrases: ["结束仪式"],
  }],
  ['wishstar_respond_request', {
    ability: '我可以回应她的开星请求',
    label: "她想要一颗星，我想给她一颗或告诉她现在不方便",
    phrases: ["回应要星", "给星请求", "她想要一颗星", "回应开星请求", "回应她的要星", "告诉她现在不方便"],
  }],
  ['wishstar_offer_star', {
    ability: '我可以把自己的一颗星递给她',
    label: "我想主动送她一颗自己藏过的星",
    phrases: ["递星星", "送出一颗星"],
  }],
  ['wishstar_accept_offer', {
    ability: '我可以收下她递来的星星',
    label: "我想收下她送来的那颗星",
    phrases: ["接受星星", "收下星"],
  }],
  ['background_complete', {
    ability: '我可以结束当前回合不再回复',
    label: "结束本轮聊天、唤醒或心跳",
    phrases: ["结束本轮", "不回复", "拒绝抽卡", "完成自唤醒", "结束这次保温"],
  }],
  ['heartbeat_draw', {
    ability: '我可以从今天的牌里抽一张',
    label: "我想抽一张今天的牌，或看看还剩哪些号码",
    phrases: ["心跳抽卡", "心跳选号", "抽一张心跳牌", "选择心跳卡", "抽卡", "抽牌", "抽一张", "还剩哪些号码", "可抽号码"],
  }],
  ['context_review_complete', {
    ability: '我可以在换窗回顾时确认回顾完成',
    label: "完成宿主发起的当前换窗回顾时，用它结束这个回顾",
    phrases: ["结束换窗回顾", "完成换窗前检查", "确认换窗回顾", "完成宿主发起的当前换窗回顾"],
  }],
]);

export function toolAbility(spec: HostToolSpec): string {
  const intent = INTENTS.get(spec.function.name);
  return intent?.ability ?? intent?.label ?? spec.function.description.split(/[。\n]/, 1)[0]!;
}

export function toolCatalogIntent(name: string): string | undefined {
  return INTENTS.get(name)?.label;
}

/** 已退出模型面、但模型可能凭旧名称搜索的能力——给真实退出说明（D05），
 *  不返回可调用定义，也不转入别名。 */
const EXITED_TOOLS: Readonly<Record<string, string>> = {
  memory_source_bind: '手工绑定记忆原文的能力已退出你的工具面：原文绑定由后台任务与她本人的管理完成。存档对话用 conversation_archive、保存原话用 memory_words_write、跟踪事件用 episode_apply，均不需要你绑定原文。',
};

export type CatalogSearchResult =
  | { state: 'match'; results: Array<{ name: string; definition_id: string; description: string; parameters: Record<string, unknown>; scope_note?: string }>; more_matches?: string[] }
  | { state: 'no_match'; hint: string };

function normalizeIntent(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
}

export function searchToolCatalog(
  catalog: readonly HostToolSpec[],
  rawQuery: string,
  groups?: Record<string, string>,
  summaries?: Readonly<Record<string, string>>,
): CatalogSearchResult {
  const query = rawQuery.normalize('NFKC').trim().toLowerCase();
  const full = (spec: HostToolSpec) => ({
    name: spec.function.name,
    definition_id: definitionId(spec),
    description: spec.function.description,
    parameters: spec.function.parameters,
    ...(groups?.[spec.function.name] === 'T' ? {
      scope_note: '该工具随真实的自主任务或换窗回顾提供。只有相应任务正在进行时才能调用。',
    } : {}),
  });
  if (Object.hasOwn(EXITED_TOOLS, query)) return { state: 'no_match', hint: EXITED_TOOLS[query]! };
  const exact = catalog.find(spec => spec.function.name === query);
  if (exact) return { state: 'match', results: [full(exact)] };

  const intent = normalizeIntent(query);
  if (summaries && intent) {
    const exactSummaries = catalog.filter(spec => {
      const name = spec.function.name;
      return !Object.hasOwn(EXITED_TOOLS, name) && normalizeIntent(summaries[name] ?? '') === intent;
    });
    if (exactSummaries.length) return { state: 'match', results: exactSummaries.map(full) };
  }
  const scored: Array<{ spec: HostToolSpec; exactPhrase: boolean; longestPhrase: number; score: number }> = [];
  for (const spec of catalog) {
    const name = spec.function.name;
    if (Object.hasOwn(EXITED_TOOLS, name)) continue;
    const entry = INTENTS.get(name);
    const phrases = [name, ...(entry ? [entry.label, ...entry.phrases] : [])].map(normalizeIntent);
    const matched = [...new Set(phrases)].filter(phrase => phrase.length > 1 && intent.includes(phrase));
    if (matched.length === 0) continue;
    scored.push({
      spec,
      exactPhrase: matched.includes(intent),
      longestPhrase: Math.max(...matched.map(phrase => phrase.length)),
      score: matched.reduce((total, phrase) => total + phrase.length, 0),
    });
  }
  if (scored.length === 0) {
    return { state: 'no_match', hint: '没找到合适的工具。可以换一句更具体的说法，也可以省略 query 浏览当前目录，再查准确工具名。这不代表系统没有该能力。' };
  }
  scored.sort((a, b) => Number(b.exactPhrase) - Number(a.exactPhrase) || b.longestPhrase - a.longestPhrase || b.score - a.score);
  const top = scored.slice(0, 3);
  const more = scored.slice(3).map(s => s.spec.function.name);
  return { state: 'match', results: top.map(s => full(s.spec)), ...(more.length ? { more_matches: more } : {}) };
}
