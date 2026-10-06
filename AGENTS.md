# AGENTS.md · estómago 仓库工作规章（摘要）

现行规范正文：`docs/specs/ESTOMAGO_OR_SELF_HOLD/01_执行架构.md`（规范标识 `ESTOMAGO_OR_SELF_HOLD`，2026-10-05 冻结）；`docs/architecture/v0.2.1/02_*.md` 为历史规格存档，其中安全/隐私/测试/输入语义硬约束继续有效。本文件只列硬约束，两代规格均适用。

1. **不造假**：能力未核实一律 `unknown`/`blocked`，不写自填 PASS；身份缺失 → `IDENTITY_BLOCKED`，不提供默认人格；mock 只在 `ESTOMAGO_TEST_MODE=1` 下可用，不得冒充实机。
2. **测试纪律**：测试一律使用独立临时 `ESTOMAGO_HOME`（禁止指向生产 `~/Library/Application Support/estomago`）；前台、分批、串行跑（`npm test`）；不连接真实外部服务、不发送真实消息；每批结束检查无孤儿进程。
3. **边界**：只改本仓库；不碰 mariposa/siren/superposition/Zashidele 等兄弟项目；网络/隧道/凭据变更需用户逐项批准。
4. **隐私**：身份正文、聊天正文、token 不进日志、不进 Git；日志只记 ID/状态/计数/hash。
5. **输入语义（v0.2.1 硬规则）**：Enter 只换行、发送只由独立发送键触发；用户多行正文是一条消息，不拆分；IME 合成期不得触发发送。
6. **命名**：产品显示名 `estómago`；仓库/进程/配置键用 ASCII `estomago`。
7. **并行交叉检查**：本仓可能多路代理同时改（ZCode/GPT 等）。每次提交前先 `git status` + `git log --oneline -3`：发现非本路的新提交或未提交改动时，**禁用 `git add -A`/`git add .`**，只 add 自己明确修改的文件；他人半成品不得卷进自己的提交；与他人改动同文件时先读现状再改；提交信息只描述自己做的部分。落地后如工作树被他人推进，重跑测试再继续。（2026-10-05 立规：ba41c18 曾把另一路改到一半的 README 卷走，内容无损但归属交叉。）
8. **基线维护**（2026-10-06 她批）：每批提交者顺手在 `README.md` 的深夜/批次索引里加一行（一句话+提交号），README 永远是最新基线入口；审计包/交接包里的 source 副本是历史快照，不得当作当前代码引用（2026-10-06 曾因此误读）。纯文档/单行改动可免。
