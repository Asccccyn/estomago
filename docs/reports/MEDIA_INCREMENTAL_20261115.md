# 第1包媒体增量实施记录（2026-11-15）

执行包：`01_MEDIA_INCREMENTAL_20261115`（规格 M01-M08）。实施基线：`unified-main-20261102` @ `d5e51f5`（W1 落地后）。未部署、未重启生产、未调用真实付费生图。

## 状态总表

| 项 | 需求 | 实现 | 验证 | 部署 | 未验证 |
|---|---|---|---|---|---|
| M01 基线 | 已修两 bug 对应+版本事实 | 不重施工（对应仍待用户确认编号：候选 84cec65+4d03f1b，开发已修、生产未含） | 只读核对（进程 cwd/launchd/DB 只读） | 生产 host=1363302、content=236bee3，RR4 全部未上 | — |
| M02 SVG/HTML 交付 | 隔离交付不放宽图片白名单 | presentation=work 全链（v71 迁移/validateForSend 分支/投影文本引用+预览入口/回执 preview_ref） | MEDIA-M02 集成过（真 MessageService+迁移链） | 未部署 | 前端气泡渲染（留前端重建）；浏览器沙箱展示未验 |
| M03 默认生成保存发送 | 默认 send、save_only 窄例外、独立发送保留 | deliver 参数+阶段4发布（确定性幂等键）+描述更新（不再补发） | IG-14（发布/仅存/发布失败只补发布/D06 重放不重发） | 未部署 | 真实供应商端到端（隔离验证） |
| M04 阶段回执/恢复 | 明确失败≠未确认 | 5xx→IMAGEGEN_UPSTREAM_ERROR retryable（failed_retryable 同键重试真实重调上游）；unknown 仅留超时/断连 | IG-12 | 未部署 | 供应商 5xx 是否计费（回执如实说"已重新请求"） |
| M05 GIF 组合 | 可确定规则进校验、不编公式 | 全网格枚举下界>3840 才拒（付费前）；其余透传供应商原因 | IG-13 | 未部署 | 供应商拼法集合（8@1024 本地放行、生产实证会被拒——如实透传） |
| M06 查看/作品读取 | 作品可发现可分页、类型真实 | content_creations_read 新工具（asset_ref/preview_ref 分型）；media_view svg/html 如实限制 | 隔离验证（新工具走真实 contentForward 链） | 未部署 | 客户端预览体验 |
| M07 相册省略语义 | 修改≠新增、留言可改可删（宿主用户 2026-11-15 裁定） | POST existing 补 caption/meaning 显式更新（空串=清空/省略=保留）；工具说明三态写清 | M07 全链测试 + FEED-06 按新合同改写 | 未部署 | — |
| M08 RR4 边界 | 不破坏既有边界 | 未触碰 RR4 代码路径；容量预算按惯例平移（目录增长） | 全量 238 文件 0 失败 | 未部署 | — |

## 关键决定与理由

1. **5xx=明确失败**：收到完整错误应答即供应商明确失败（规格 M04 表两行分开的依据）；生产实证 11-12 09:03 unknown 卡死、09:35 换键重付费。计费不确定性在回执措辞如实（不承诺未计费）。
2. **GIF 只拦必拒组合**：8@1024² 存在 3×3 网格（3072≤3840）但生产实证被拒——证明供应商拼法集合 ≠ 全部网格，故本地只拦"任何网格都超限"（如 16@1024），其余交供应商并透传原文。
3. **发布幂等不用新列**：确定性 clientMessageId 复用消息表唯一索引（与 chat_send_attachment 同一发布入口），saved 后同键重放幂等补发布——不建并行账本。
4. **caption 语义按用户裁定**：宿主用户明确"修改/编辑/删除"——空串=清空为唯一清空表达（PUT 已是 COALESCE 语义，POST existing 对齐）；updated_at/revision 随实际变化推进（与浏览器 PUT 一致；consume-next-once 的 before 基线竞态窗口极小且后果良性，不为 caption 加特判）。
5. **FEED-06 断言改写**：旧断言编码"POST 撞已有=纯幂等返回不更新"，与用户裁定的新合同冲突；按"先怀疑测试不把旧审计当合同"改写为新语义断言（身份不变+caption 更新+revision 推进）。
6. **容量预算平移**：目录 +2059B（中文为主）使首轮 wire 变大，首轮即触软线导致换窗状态机测试连环失败；按 RR4 惯例平移 8 处常量（实测 25_850 仍不够——中文 token 比率高于 ASCII ÷3.6 估算，最终 26_450 档）。

## 测试与证据

- 新增/改写：IG-12（5xx 分类+同键重调）、IG-13（GIF 必拒/放行边界）、IG-14（默认发布/save_only/发布失败恢复/D06）、MEDIA-M02（work 白名单双向+投影）、M07（caption 三态+幂等重放）、FEED-06（新合同）。
- golden 三件重建（tool-catalog C 组 45→46；envelope/module-contract 经 ESTOMAGO_UPDATE_GOLDEN=1 显式重建）。
- 全量 238 文件 0 失败（隔离 ESTOMAGO_HOME）；typecheck 过。
- 生产证据（只读）：imagegen_operations 中 unknown(供应商500) 与 GIF 8@1024 拒绝样本原文取证。

## 遗留与交接

- 部署：本批 + W1 + RR4 全部在开发仓未上线；部署需用户对重启/中断单独授权，release 从 HEAD 建（make-release.sh），content 服务同批。
- GIF 真机、供应商 5xx 真实行为、客户端播放：待授权/待观察（不隔离冒充）。
- "两个历史相册 bug"编号对应、`\u` 转义所指修复：仍待用户确认（包2 DBG-12 已接 \u 转义事项）。
- 交第4包：image_generate 新 deliver 参数、chat_send_attachment presentation=work、content_creations_read 新工具、content_album_entry_write 新说明——合同快照已随 golden 重建同步。
