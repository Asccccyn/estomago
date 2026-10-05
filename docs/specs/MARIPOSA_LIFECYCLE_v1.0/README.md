# Mariposa × estómago 生命周期工程包 v1.0

先读 `00_GLM执行方案.md`，交给 GLM 时也可以从 `发给GLM.md` 开始。

- `01_源码证据与差距.md`：真实 checkout 与设计包的核对边界、源码行号。
- `02_验收矩阵.csv/json`：58项待执行验收；初始全为 NOT_EXECUTED。
- `contracts/`：拟新增/扩展参数的合成契约样例，不是部署后的 API。
- `references/`：读取时取得的设计文本原样副本，供离线核对；冲突按主方案处理。
- `SOURCE_HASHES.sha256`：只读取证文件身份；不包含源码/数据库。
- `PACKAGE_CHECKS.json` 与 `MANIFEST.sha256`：包内文档、JSON 与示例自检；不是产品验收。

本包完成的是方案。未修改本机代码、未运行生产迁移或模型、未跑项目 pytest。
