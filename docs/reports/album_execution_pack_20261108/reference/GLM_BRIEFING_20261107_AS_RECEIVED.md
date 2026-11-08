# 图片原文归档 × 相册 × embeddinggemma-2 —— 现状、问题与架构决策简报

> 写给林石见（GPT）的评审简报，2026-11-07。数据来源：2026-11-07 四仓结构审计（全链源码取证）
> + 本日两批施工后的最新工作树。estómago（E）HEAD `b10189c`、Mariposa（M）HEAD `56a8fd7`，
> **均未部署**（生产仍跑 release 检出：E host=ee4f9fc / M=7c16a8e）。部署已按宿主用户指示暂停，
> 待本文架构讨论结论 + 相册一并安排。

---

## 0. 系统拓扑（一分钟版）

```
手机/浏览器 ── Cloudflare 隧道 ──> estómago host (Node, :18787)
                                    ├── apps/content (:18788)  朋友圈/相册/作品/未来信 后端
                                    ├── Mariposa (:18780, FastAPI)  记忆/原文/检索/语义事件
                                    ├── Siren (:8790)  ASR/TTS/实时通话
                                    ├── oído (:8791)  声音证据（韵律分析）
                                    └── media-embedding (:8792, Python)  embeddinggemma-2 图片/文本向量
E 数据根：~/Library/Application Support/estomago（SQLite + media/ 文件库）
M 数据根：~/Data/mariposa（正式库 + runtime/source/raw 原文快照 + 对象存储）
```

---

## 1. 图片链路现状（聊天里发一张图之后发生什么）

**当前实况（已核实到 file:line）：**

1. **上传**：React 前端 `POST /api/v1/assets?purpose=chat_image|chat_sticker|chat_voice|creation_icon|creation_work`
   （`apps/host/src/server/routes/assets.ts:92-104`；purpose 白名单 + 分类型容量门 + 幂等键）。
   字节落 **E 本地 media store**（`~/Library/Application Support/estomago/media`，按月分目录；**当前总量 32MB**）。
2. **消息挂接**：`message_attachments`（presentation=voice/image/sticker）+ `asset_external_refs`
   （content 服务引用账本：pin→commit→快照确认，`ContentOperationCoordinator`）。
3. **归档到 M（原文层）**：`ArchiveSyncService` 批同步调 `source.ingest`——**只送资产引用（asset ref）+
   附件转写文本**，从不送图片字节（`apps/host/src/integrations/mariposa/archive-sync.ts:305-338`）。
   M 侧落 `source_conversations/source_messages` + `source_message_attachments_meta`。
   晚到附件（深听观察/通话原声）另有 `source.attachments.sync`，同样只带 meta。
4. **M 原文页（人类查看面）**：`frontend/src/App.tsx:1433` —— 显示一行小字"**此消息含 N 个附件**"。
   连 URL 都没有，更不渲染图片。
5. **模型消费面**：E 信封装配时 `asset_image` 引用在发送边界物化为原生图块（型号视觉能力已核实才放行，
   否则 `MODEL_VISION_UNAVAILABLE` 零请求阻断）；`media_search`/`media_view` 工具读 E 本地向量索引与文件。
   M 侧模型（浮现 judge 等）纯文本，无图片消费。

**缺口总结**：图片字节正本只在 E；M 的原文层只有"曾经有过一张图"的记录；原文页无法回看图片。

## 2. M 媒体间现状（B8 能力面，"装修完好、从未使用"）

- **能力**：`media.upload.prepare/finalize/get/list` + HTTP 直连面 `PUT /api/media/stage/{token}`
  （分块流式暂存、声明 size 精确校验、即时截停）+ `GET /api/media/object/{hash}`（按内容 hash 取回）。
  鉴权走 M 的 principal bearer + 写限速（`backend/mariposa/app.py:650-660`）。
- **存储语义**：content-hash 对象存储（同图去重天然成立），两段提交（prepare 拿 token → stage 传字节 →
  finalize 落正），暂存 TTL 磁盘回收（MT-05，2026-11-06 修：暂存启动收尾消费者）。
- **现状**：两仓（E/M）**零调用者**。它是为"图片/媒体字节进 M"预建的，等一条归档线。

## 3. 相册（content 服务）现状

- **后端全量就绪**：posts（朋友圈）/albums+entries（相册）/creations（作品）/future-notes（未来信）
  共 15 条写路由 + 幂等回执（指纹化命令身份）+ 引用账本 + 恢复消费者（15s 循环收口崩溃遗留意图）。
  G5 存量回填已于 2026-11-07 执行完毕。
- **消费面**：前端只有"作品"面板用了 1 条读接口（`GET /content/creations`）；相册有模型工具
  `content_albums_read` + 宿主权限检查；**无任何人类 UI**（网页/iOS 均未做）。
- **与图片资产的关系**：相册条目（album_entry_refs）引用 **E 资产 id**；字节本体在 E media store。
  content 相册与 M 媒体间目前零关系。
- **宿主用户已定的产品语义**：**est 相册=人工策展层（只存重要的）；M 媒体间=原文层（聊天图片全量自动留存，
  查原文时图片直接显示在对话里）**。即同一张图可能同时进"原文层（自动）"和"相册（人工挑选）"。

## 4. media-embedding（embeddinggemma-2）现状

- **模型**：`google/embeddinggemma-2`（pinned revision `914f7f89142e33e77833254d9c9b90c3cef7303b`，
  768 维，L2 归一），**本地权重**（SentenceTransformer 加载 pinned cache，`EG2_BACKEND=eg2`），
  多模态（文本+图片同一空间），指纹常量 `preprocess=v1|dims=768|norm=l2`。
  无远程 API、无按调用计费。
- **服务面**：`GET /health` + `POST /v1/embed`（可选 bearer；**全局并发 1**，忙=503；items≤16；64MiB 上限）。
- **现有消费者（真实在用）**：E 的 `media_search` 模型工具 + 15 秒补索引循环（≤5 图/跳，指数退避）。
  即"发过的图可被模型语义搜到"这条链**已上线并在生产运行**。
- **问题清单**：
  1. **部署拓扑不一致**：它是唯一**直接从工作树**（`~/Projects/estomago/services/media-embedding`）
     运行的服务（launchagent `com.charstarearth.media-embedding`）——其余全部服务跑固定 release 检出。
     工作树被并行代理改动时运行版本漂移，无版本可追溯。已列入部署批：挪正式 release 目录。
  2. 并发 1 + 503：批量补索引时吞吐受限（当前 32MB 库容下无感；相册全量接入后需评估）。
  3. 与相册零接线：索引只服务 media_search；相册要"语义找图"需把 content 相册查询接到同一索引
     （相册条目引用 E asset id → 同一 asset 的 embedding 已存在，**接线成本低**）。
  4. 生产实配开关在密钥目录未读（`media_embedding.base_url` 实际值未核实——按默认应为已配置，
     因补索引循环在跑；部署批顺道核实）。

## 5. 待决策的架构问题（本文核心，请林石见重点看）

### 决策 1：图片字节正本放哪（A/B 两条路线）

**方案 A（宿主用户构想直译）——M 为图片字节正本**：
E 归档链把字节推入 M 媒体间（content-hash 对象库）；M 原文页从自家对象库取图直接渲染；
E 本地 media store 保留或降级为缓存。
- 优点：原文层自洽（文字+图片同库同备份故事）；hash 天然去重；M 备份一次带走全部原文。
- 代价：E↔M 双份或迁移；E 侧模型消费（信封图块/media_view）仍读本地——需要保留或回源代理；
  推送链要设计幂等（byte-hash 相同不重传）与失败重试（归档 outbox 现有 10 次有界重试可复用）。

**方案 B——E 恒为字节正本，M 只存 hash+meta**：
M 原文页渲染时经签名 URL / 代理回 E 取图（`GET /api/v1/assets/:id/content`）。
- 优点：单一字节正本；模型消费路径不变；改动集中在渲染层。
- 代价：M 前端跨服务取图的鉴权设计（M 有自己的登录态，E 是另一套 owner 认证——需要
  服务间签名或 M 后端代理流式转发）；M 备份不带图片；E 不可达时原文页图挂。

**宿主用户语义下我（GLM）的倾向**：A 更贴合"媒体间=原文层"的裁定，且复用 M 已建好的
upload.prepare/stage/finalize + TTL；但 B 改动小。请你们定。

### 决策 2：归档推送的位置与合同
- 选项 i：`source.ingest` 扩展带字节（一批消息+附件字节混传——批语义变重）。
- 选项 ii：独立 capability `source.attachment.put`（byte-hash 幂等，归档 worker 逐附件调用）。
- 选项 iii：直接复用 `media.upload.prepare/finalize` + stage HTTP 面（媒体间原生两段提交）。
- 附带：M 侧 `source_message_attachments_meta` 增加 object_hash 列绑定字节对象。

### 决策 3：相册与两层媒体的关系
- 相册条目引用 E asset id（现状）还是 M object hash（若 A）？
- "重要的进相册"是纯人工挑选，还是允许"从原文一键收藏进相册"（需要 content 写入口接 M 读面）？
- 相册 UI 时机：网页端先做，还是并入 iOS 原生（iOS 就绪度审计已确认相册/朋友圈后端对原生足够）。

### 决策 4：gemma2 的接线与部署
- 相册语义检索接 E media index（成本低，见 §4.3）。
- media-embedding 进 release 目录（部署批，重启需宿主用户单独同意）。
- 若相册全量接入后并发 1 成为瓶颈：worker 侧并发参数化或队列化（当前无证据需要，先不动）。

### 决策 5：部署编排（宿主用户已暂停切换，等这轮讨论）
待上线内容已堆：episode 开窗片段（E b10189c+M 56a8fd7）、106 能力合同、假开关退役、
以及将来的图片归档+相册。建议一次部署窗口统一切（含 media-embedding release 化），
避免多次重启。

## 6. 建议分批（供讨论起点，非定案）

1. **批 1（E+M 联合）**：图片字节归档链 + M 原文页图片渲染（按决策 1/2 的结论）。
2. **批 2**：相册消费面（UI 或原生，按决策 3）+ gemma2 相册接线。
3. **批 3（部署批）**：release 化 media-embedding + 全部待上线能力一次切换 + 真实冒烟
   （发消息/发图/通话/深听/相册各一）。

---
*证据索引：assets.ts:92-104 / archive-sync.ts:305-338 / App.tsx:1433 / app.py:650-660 /
media-embedding worker.py:22-106 / media/index/service.ts:24 / content service.ts:357-758 /
MCP_CAPABILITY_INVENTORY.md / EPISODE_ASSEMBLY_PROPOSAL.md（本轮已实施）。*
