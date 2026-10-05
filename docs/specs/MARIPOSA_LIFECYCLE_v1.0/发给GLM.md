# 发给 GLM 的任务入口

请执行同目录 `00_GLM执行方案.md`，先读 `01_源码证据与差距.md`。这是 estómago × Mariposa 生命周期增量任务，不是重写聊天平台或记忆库。

从 WP0 开始读取现场真实代码、AGENTS 与当前 HEAD；Mariposa 取证基线是 main / 90d730ec2ba1fdaba1f73daa471630afd7c3b33c。HEAD 已改变时先做与本任务相关的差异映射，保留已有改动，不 reset/覆盖。estómago 的 apps/host 路径来自设计包，未在本报告里验证落地；先确定真实底座，再接入，不凭文件名假定模块存在。

必须遵守：主模型判断语义和是否 hold；Host 管消息/回合/换窗/提醒，Mariposa 管正式记忆/原文/可选语义状态。普通闲聊可无 episode、无 hold；零新增 hold 是有效检查结果。不要再加小模型查漏、逐回合强制判断、后台全历史扫描、summary/handoff 长故事或任何自动遗忘。

优先补 source 实时追加与不可变修订，以及 memory.hold 同事务领域回执和来源绑定；再做可选 episode CAS 与 Host 检查衔接。技术 Stop/断网/午夜/缓存到期不能自动 close；新话题不必关闭旧话题；plan 与 Recall Session 不许挪用。新受限归档凭据不能调 hold/I/删除；主模型身份只能从批准绑定解析。

按 WP 小步提交、按项目资源约束分批离线测试。禁止访问生产聊天做夹具、调用真实收费模型、升级 SDK/认证、改 VPN/Tunnel 或部署生产。正式迁移/联调另需明确授权。现场尚无 Host 底座时完成契约/适配骨架与 mock，把真实联调标 BLOCKED，不伪报完成，也不要偷偷重建整个 estómago。

每个 WP 更新报告与 `02_验收矩阵` 的真实状态。最终给出 IMPLEMENTATION_REPORT.md、逐项测试证据、文件/commit/迁移清单、故障恢复与未完成项。文档静态自检通过不等于产品测试通过。所有新增命名先检查冲突，以业务合同不变为前提做最小映射。
