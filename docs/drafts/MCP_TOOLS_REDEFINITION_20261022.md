# MCP 工具面重定义 · 供她勾选（2026-10-22）

她的原话：「重新定义下 mcp 所有的工具，我来判断哪几个可以一开始就读，不然char不太会用 hold」。

机制说明：当前 wire 上只有 3 个入口（tool_catalog 列目录 / tool_define 取定义 / tool_invoke 调用），
其余工具按需发现——char要"先用 catalog 看到、再 define、再 invoke"三跳。她要判断的是：
**哪些工具定义应该直接进入开窗上下文（一开始就可见），不再要求三跳。**

下面按功能分组列出全部 39 个工具，附一行用途与"初始可读"建议（★=建议一开始就在；
依据：写记忆链路核心=hold，他说不太会用；读面高频=recalls/I）。**勾选列留空，等她批。**

## A. 记忆写链（hold 问题主区）

| 工具 | 用途 | 建议初始可读 | 她的勾选 |
|---|---|---|---|
| memory_hold | 写正式记忆（标题/分类/事件/心情/我们的话） | ★（他不会用 hold 的主因=定义藏在三跳后） | ☐ |
| memory_i_write | 维护 I 条目（create/revise/restore） | ★（刚修好 I_FORBIDDEN，不给定义等于白修） | ☐ |
| plans_write | 维护计划（create/update） | ★ | ☐ |
| identity_milestone_write | 维护长期记忆里程碑（1022 起条目化） | ★（新能力） | ☐ |
| episode_apply | 语义事件线操作（start/pause/…） | | ☐ |
| memory_correct | 关系/绑定纠错 | | ☐ |
| context_review_complete | 换窗前记忆检查收口 | 系统提示已引导 | ☐ |
| deletion_review | 删除申请审批 | | ☐ |

## B. 读链（高频检索面）

| 工具 | 用途 | 建议初始可读 | 她的勾选 |
|---|---|---|---|
| memory_recall | 自然语言查记忆 | ★（回忆主入口） | ☐ |
| memory_recall_next | recall 结果翻页 | ★（与 recall 成对） | ☐ |
| memory_read_full | 浮现 ref 定点读取 | ★（自动浮现的配套读面） | ☐ |
| conversation_read | 读聊天原文 | ★（高频） | ☐ |
| memory_i_read | 读 I（current/items/单条） | ★ | ☐ |
| plans_read | 读计划 | ★ | ☐ |
| memory_open | 明确打开记忆+回忆 | | ☐ |
| episode_list / episode_get | 事件线列表/详情 | | ☐ |
| content_posts_list | 看朋友圈 | | ☐ |
| wishstar 12 项（读 4 写 8） | 许愿星全部面 | | ☐ |

## C. 表达/后台

| 工具 | 用途 | 建议初始可读 | 她的勾选 |
|---|---|---|---|
| chat_send_text | 正式发言（自主/心跳唯一公开发言途径） | ★（不提前给定义=到期不会说话） | ☐ |
| chat_send_attachment | 发图片/表情 | | ☐ |
| media_import | 外链图片导入 | | ☐ |
| content_post_create / content_comment_create | 朋友圈发帖/评论 | | ☐ |
| creation_save_artifact | 存 SVG/HTML 小作品 | | ☐ |
| wake_manage | 自主预约唤醒（1022 新） | ★（预约功能主入口） | ☐ |
| background_complete | 结束后台回合 | ★（与 wake 成对） | ☐ |
| wishstar_write_star | 写星 | | ☐ |

## 实现口径（她勾选后落地）

- 初始可读 ≠ 权限放开：只是把该工具定义放进开窗上下文（省 catalog/define 两跳）；
  权限/审计/幂等门不变。wire 入口仍是 3 个+已读定义原样执行。
- 按窗冻结：勾选清单生效于下一扇新窗（旧窗 tools 快照不动，缓存不断）。
- 配置面：runtime_settings 一份 `tools_initial_visible`（JSON 数组），她可随时改。

——等她勾选后我按清单实现（约半天：配置键+开窗装配+测试）。
