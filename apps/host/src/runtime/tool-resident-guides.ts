import type { HostToolSpec } from '../capabilities/contracts.ts';

// 开窗里的简明用法。执行和按需查询仍读取窗口冻结的完整 schema。
const GUIDES = new Map<string, string>([
  ['memory_hold', `记下你自己想记的一件事。填 original_title、完整的 text、至少一个 categories 和 creation_mode。标题 1 到 30 字。原话用你能核对的引语。
分类值是 daily 日常、milestone 关系重大转折、sad 难过、sweet 甜蜜、date 约会、plan 计划、sex 性事、anniversary 纪念或第一次、reloplay 角色扮演、diary 成篇信或日记。diary 和 reloplay 要各自单选。选 plan 时给相应的已有 plan_ids。
当下记录选 contemporaneous，省略 memory_date 就用今天。可填 mood_tags 和 mood_note，心情标签最多三个{mood_values}。补记选 retrospective，并填事情发生的 memory_date，格式 YYYY-MM-DD。日期把握可填 date_confidence，值为 exact、inferred 或 unknown。
回执 saved: true 和 memory_id 表示已记下。可以直接存。结果未知时先等宿主核对。`],
  ['memory_update', `发现一条已经记下的事写错了，可以直接改那一条。填原来的 memory_id 和最新版本 expected_version，版本从保存或读取回执取。改正文时，text 填改好的全文。也可改 original_title、categories、memory_date 或 date_confidence。其余字段省略就保留。版本冲突时先读新的内容和版本，再决定怎么改。`],
  ['memory_recall', `主动回想一件事，或找一句存过的原话。首轮填 query，用自己的话说你在找什么。默认 channel: event 找事，选 words 找原话。可以用 lexical_terms 补关键词，用 date_from 和 date_to 一起限定日期，单日就填同一天。明确要重看或逐字核对时用 reread: true。
回执给 next 时，可按它给你的 tool 和 arguments 继续。同一组结果翻下一页用 memory_recall_next。想换说法再找，沿用回执里的 refine_session_id 和 refine_continue_ref，并填 channel 和新的 query。想排除一条已交付候选，用它的 resource_ref 填 reject_candidate_ref。需要继续搜聊天原文时，按回执给你的原文续查参数进行。`],
  ['memory_read_full', `已经搜到或想起一条记忆，想仔细看时，把回执里的 memory_ref 原样传回。section 省略时读记忆详情，用 source 读它连着的原文，用 relations 看关系。翻下一页沿用同样的 section，把 next_cursor 填进 cursor。她明确要重看或逐字核对时，填 reread: true。`],
  ['image_generate', `画一张图。填 prompt 描述画面，再给这次生成的 client_operation_id。默认生成静态图、存到相册并发到当前聊天。想先自己看，填 deliver: save_only。sent: true 表示已经发出。
选填 title、size 和 format。格式可用 png、jpeg、webp、gif。动图要填 format: gif，可填 frame_count 2 到 16、frame_duration_ms 至少 20 毫秒。帧越多，单帧可用尺寸越小。
结果里的 asset_ref 可以实际看图，asset_id 可以收藏或发图。重试沿用同一 client_operation_id。结果未知先核对，保存或发布失败按回执补那一步。`],
  ['media_view', `想亲自看看相册里那张图，或刚画好的图，把回执给你的 asset_ref 原样传过来。工具实际返回图片时，你就能看见它。`],
  ['chat_send_voice', `想主动给宿主用户发一条语音，填 text 写下你要说的原话。可以用 tts_script 补充合成表达。回执 state: published 表示已发出。若音频已保存而消息没发出，她只想补发时，按回执用原音频。`],
  ['call_control', `想主动给宿主用户打电话，在当前私聊用 action: invite 发出来电邀请。等她选择接听或拒接。需要查看已有邀请的状态时用 action: status。拒接或未接后等新的邀约意图再打。`],
  ['wake_manage', `给未来的自己定一次唤醒。operation 用 schedule，填 operation_id 和到点交给自己的 note。时间二选一：at 是带时区的 RFC3339 时间，delay_seconds 是离现在多少秒，填正整数。可以同时有多个预约。
operation 用 list 查看自己的预约，默认 20 条，可填 limit 1 到 100。续页把回执的 next_cursor 填到 cursor。update 或 cancel 填已有 task_id、当前版本 expected_revision 和 operation_id。update 至少改时间或留言。写操作重试沿用同一个键和同一组参数。`],
  ['wishstar_write_star', `写一颗星。填 content、visibility 和 idempotency_key。正文最多 2000 字。visibility 用 visible 放进共同瓶，两人可见。用 hidden 放进自己的私人瓶。
可附 mood_type 和 mood_text，各最多 100 字。note 最多 500 字。同一颗星重试沿用同一个键。`],
  ['wishstar_request_star', `问宿主用户要一颗她藏起来的星。直接传空对象 {}。回执给请求状态，等她回应后再看能否读到那颗星。结果未知时，可以用 wishstar_read 的 what: requests 核对。`],
  ['content_album_entry_write', `把已有的图收进相册。填 kind、图片的 asset_id 和 idempotency_key。kind 用 important_photos 收藏重要照片，用 stickers 收进表情包。用图片 ID，不用相册条目的 ID。
可填 caption 留原话、meaning 写你对图的说明，各最多 2000 字。改已有条目时，省略就保留原值，填空串就清掉。carry_mode 只给重要照片用。none 只收藏，next_once 下次换窗带一次，always 每次换窗都带。新建省略时只收藏，更新省略时保留原设置。同一次操作重试沿用原键。`],
  ['content_albums_read', `翻相册。传空对象 {} 先看有哪些相册。想翻具体相册就填 album。important_photos 是重要照片，chat_screenshots 是聊天截图，stickers 是表情包。
每页默认 20 条，可填 limit 1 到 100。q 按标题或说明找。按来源筛选时一起填 source_service、source_kind 和 source_id。翻下一页要保持相册和筛选，取回执的 next_cursor 填到 cursor。想真正看图，把条目里的 asset_ref 给 media_view。`],
  ['content_post_create', `以你的身份发一条私密朋友圈。填 body 和 idempotency_key。只发图时也给 body，填空字符串，同时用 asset_ids 给至少一张已有图片。附件最多 8 张，body 最多 40000 字，可填最多 200 字的 title。
presentation 默认为 post 普通动态。想用信的排版就填 letter。同一次发帖重试沿用原键，结果未知时先按回执核对。`],
]);

export const residentToolNames: readonly string[] = [...GUIDES.keys()];

export function residentToolGuide(spec: HostToolSpec): string | undefined {
  const name = spec.function.name;
  const guide = GUIDES.get(name);
  if (!guide) return undefined;
  if (name !== 'memory_hold') return guide;
  const properties = spec.function.parameters.properties as { mood_tags?: { items?: { enum?: string[] } } } | undefined;
  const moods = properties?.mood_tags?.items?.enum;
  return guide.replace('{mood_values}', moods?.length ? '，可选' + moods.join('、') : '');
}
