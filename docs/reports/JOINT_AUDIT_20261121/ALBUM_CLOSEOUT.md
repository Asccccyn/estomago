# ALBUM_CLOSEOUT · 相册与历史作品

**代码能力部分完成，历史数据未全部迁移。** 浏览器从真实首页的“相册”热点进入正式管理页。一次图片关系写入被注入 503 后，刷新页面、继续入库，关系请求两次、操作键相同，假媒体正本只收一次上传。照片可预览，同一 asset 加入表情包，删除照片关系后表情依然可读。独立 GIF 可从表情页直接上传，错误文件显示 asset_type_unsupported。以上管理操作产生 0 个聊天 turn、0 个 provider 请求。

## 查询范围与对象

只读规划输入为 `rollback-estomago-v12-20261120-232610/data/chat.sqlite3` 和配对的 `content/content.sqlite3`，对应切换前最后一次停机备份，时间见主报告。执行仓内 `scripts/plan-image-creation-migration.mjs` **plan** 并按 `creations.deleted_at IS NULL`、相册成员、源关联、资产的 available/synced、权威 hash 交叉核对。没有在该备份、生产库或真实源执行 apply。11 月 20 日晚的生产补录交接与快照 ID 一致。以下是快照事实，后续有新数据应重新生成迁移计划。

|状态|真实对象与数量|原因、影响、下一步及完成条件|
|---|---|---|
|保留作品，迁移无需移动|6 个活跃 HTML 作品，ID 见下表。另有 3 个 HTML 墓碑。|作品关系和原文件映射存在，主资产映射均有匹配权威 hash。两件官端补录有 HTML、SVG 图标、版本与 M 字节哈希回执；其他四件没有在本次逐一运行依赖包。避免给未重新验证的依赖签完整可运行。|
|原件已在，只缺相册关系|7 个活跃位图作品被 planner 判 propose_album_entry。|原文件均有可核验主资产，新旧身份可绑定。先消除旧图片新增入口，再从最新一致快照生成计划，在隔离副本 apply 两次，按同一 creation 只生成一个对应关系；生产数据另行授权。保留原作者、原登记时间和固定旧引用。|
|已有相册成员，缺作品来源关联|4 个活跃位图作品被判 review_existing_album_entry。|当前成员已存在，对应源链接缺证据。查同 asset、hash、成员作者与来源意图，确定只补 creation→entry 关联；保留原成员 ID、留言、carry_mode 和创建时间。不得再上传或重建原成员。现行 apply 不自动处置 review 项，应显式提交经核对的关系修订。|
|已核为静态图片，待支持发送视图|1 个 SVG，`crt_mwdbk2zb33f81cff`。planner 给 review_original_format。|回源缓存原件 3,324 字节，SHA-256 与备份权威 hash 相符。只读 XML 有 circle/line/rect/gradient/text 等，无脚本、动画、外部链接、事件属性或样式表。当前静态组件白名单没有 text；合成 rect 通过 worker（110 B PNG），合成单 text 返回 65、无 PNG。原件已找回，不需要重画。让图片分类和可安全生成发送视图分别表达，保留原 SVG 与来源，验证含文字的静态子集，再补相册关系。|
|已删除|4 个旧作品墓碑，其中 3 HTML、1 image。|不在 18 个活跃项内。清单下面有 ID；不可因重跑迁移而恢复。旧聊天引用与已撤关系的读取需分别核对。|
|旧收藏缺 hash，此范围为零|活跃 album_entries 8 行，均为 important_photos；8 个权威 M hash、8 个可用且已 synced 的源资产，NULL 为 0。此快照没有 sticker/screenshot 成员。|老的 W1 报告描述的是旧行兼容问题。现行 carry-hash-authority 测到旧 NULL 行的读源补身份和 10 张限制；这里没有可批补的无 hash 成员。未来新导出若有 NULL，以 asset 映射/权威同源确认后补；同名不足以合并。|
|有原件待导入 / 缺源码或依赖 / 源不可读 / 待判同源|18 个活跃作品中主资产映射不可用 0；上述 SVG 原字节可读。官端目录以外三类的总体数**未知**。|本地两条官端回执只覆盖那两件；未取得完整官端 ID/版本、依赖清单和全部文件。取得获准导出、manifest、原时间及来源证据后按源 ID、修订和 hash 比对，逐件列缺文件或缺依赖。登记缺项时保留可见历史。未取得原件或完整清单前，不能写零缺失或“已全量补齐”。|

|规划动作|对象 ID|
|---|---|
|7 个建议补关系|`crt_mw8kllxlf6b75859`、`crt_mw8p6puk4297a7ed`、`crt_mw8pbka44b6336e5`、`crt_mwd4ccjr573c9bd1`、`crt_mwd4eocj63062193`、`crt_mwj6tna9c43065ef`、`crt_mwkotya5d4f8fdac`|
|4 个已有成员待关联|`crt_mwaczcfpaf40c64b`、`crt_mwan0wv80a3cb553`、`crt_mwdcrokgd4ce7818`、`crt_mwg921y540f47020`|
|6 个保留 HTML|`crt_mvcf58986aaa7f6a`、`crt_mvcf589v43fdc50a`、`crt_mvcg1bziaf94bb11`、`crt_mvcg1c015e1dc514`、官端补录的 `crt_mwpvngi1aa7a0892` 和 `crt_mwpvngie99c6bb22`|
|4 个保留墓碑|`crt_mvcenxha6bba6bcf`、`crt_mvcenxhoc7f5289b`、`crt_mvcenxi16b5e257b`、`crt_mw80fgmz8867c037`|

官端两件的补录时间来自 E 登记；官端 ID、版本与历史原文 ID 在既有交接中有证。来源时间与导入时间应分别记录。不从版本字符串推断未知作者或创作时刻。

## 入口、格式和退出条件

- **照片、截图、表情。** 上传选择的是明确集合。相册有重要照片/聊天截图两种，表情有独立用途。页面按 next_cursor 加载；`modules/media/service.ts` 的集合过滤与 backfill 读取 Content 成员，MCP 的 photos/stickers/creations 含义有独立边界。分页用合成库七个同时间条目分多页验证，携带按权威 hash/别名核对，十张可带，第十一张不同身份被拒。未逐一在浏览器点击 50+ 条实图或跑真实 embedding。
- **GIF。** 原格式能保存，浏览视图可以加载。另用双帧合成 GIF 重放现行 image-delivery 用例，真实 MCP 返回 image/gif 与相同 67 字节；API 信封物化和 SDK 历史 tool_result 均为 image/gif，撤成员后此读取资格消失。验的是本地交付合同；供应商对动画的解读未实测。动画 WebP 有 MIME 准入，未另用动态图逐帧验证。
- **静态 SVG 与作品。** 支持的静态形状会保留原件并生成同源 PNG；含动画的 SVG 可留作品。当前无法渲染的静态 SVG 走作品回退，带 text 的真实旧件已定位。图片分类需基于内容，不能以“渲染失败”直接判代码。作品页能列和沙箱预览 HTML/SVG；管理面没有通用上传代码文件或逐项移除按钮，且已认证纯位图 POST 仍可创建作品。退出条件为所有正式新增入口一致，历史旧 ID 依旧可读，新的图片不再积累成待迁名单。
- **成员删除与候选。** 删除只撤当前集合。十张合成照片编牌后，经正式 DELETE 撤下 1 号图片，专页仍把该号码列作可选。再次选号时真实解析拒绝、号码才消失，没有消费或换内容。修复应消费删除事实，立即撤销未派发号码的资格，同时保留其他显式关系以及已冻结卡的身份、已发生的协议与历史。
- **幂等与落正。** 同键不同字节会冲突；同一字节、同键改变 purpose 的实测结果却是 201/201 同一资产。应在上传的唯一操作边界同时核对用途及内容。先获 asset、后建关系的可恢复路径已通，正常同图多集合只应新增关系。清理必须保留尚未获 M 确认的唯一暂存。
- **迁移验收。** 计划差异、CAS、引用保护及不可复活墓碑由 `scripts/{plan,apply}-image-creation-migration.mjs`、`apps/content/src/raster-creation-migration.ts` 和 `image-creation-migration-plan.test.ts` 覆盖。后者在合成副本跑过重复迁移、旧引用和删除后重放。真实 7 和 4 的完成证明需是最新一致快照与经授权的关联回执，不能用脚本存在或切过 v9 代替。
