# BLOCKERS

| ID | 受影响卡/能力 | 具体缺口与源码证据 | 当前普通使用影响 | 为什么不能自行补 | 可继续部分 | 所需决定/合同 |
|---|---|---|---|---|---|---|

目前未执行，因此不预填“无阻塞”。缺乏外部合同不能编造端点或默认成功。

## 未做部分（如实登记，非阻断已验收路径）

- P07.1/P07.2 剩余域路由（2026-10-25 第二轮后缩小）：已迁 server/routes/ 四组——voice-call（批次5）、content+background（6df168b）、conversations+oido-ui（80fd59f）；全量 188/188 与定向 7/7 通过。仍留 http.ts：events SSE、runtime-settings、time/calendar、assets、dial/invites、token-estimates、system-alerts、turns、voice/status+transcribe（纯结构收尾；路径/认证/响应零改动）。
- P07.6 前端：零改动（apps/web 未触碰；源树两项未提交 dist 产物未卷入）。
- （已消除）前次登记的 P08 两项演练缺口：演练A26/A03 与演练A27 已落地（批次6，probe-module-extension-drill 两用例）；B 演练 real/fake/absent 三形态独立夹具已存在（oido-substitution-isolation-drill）。
- （已消除）前次登记的兼容过渡：runtime/host-tools.ts（批次4 删除）、SurfacingMessageHooks/legacyCompatView（批次5 删除）——MIGRATION_MATRIX 对应行已闭环。
- 真实收费/生产部署：NOT_EXECUTED（07 §6 第 4 层，需另行授权），非本分支可补。
