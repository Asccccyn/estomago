# 依据、事实范围与参考资料

## 本包的直接依据

最高优先级更正（v1.1）：宿主用户明确说明当前没有并发开窗，前端显示同一个窗口；所谓换窗是上下文满后，携带原文与开窗包顺序滚到下一段模型上下文。本版撤销 v1.0 中林石见自行增加的多窗口并发领取及目标绑定要求，修正需求、实施批次和验收，不是只在术语上替换名称。

1. 本轮宿主用户明确补充：带入图片上限 10；diff 审计及修复已完成；可以实施相册；施工起点即重构、删除/退役不用旧代码、守住 M/E 模块边界；不接受事后再做死代码或深耦合拆分专项；不能自行省略；做不到报告并暂停；M/E 不保存两份媒体；工作树上的向量服务优先迁入正式 release 并直接接入。
2. 上一轮已共同对齐且按本次更正理解：M 全媒体唯一字节正本，现有 content 管分类留言；四类 E 入口；真实作品；精选照片和仅收藏/下次滚窗一次/每次滚窗三种策略；对话存档范围/版本与记忆绑定分开；争吵存档不清洗当前上下文段；通知、取消、来源边界；图片 Gemma、存档 M 既有千问。
3. reference/GLM_BRIEFING_20261107_AS_RECEIVED.md 是用户上传原文的原样副本。它陈述旧版代码取证，不是当前现场核实结果。旧提交、运行路径、能力数量、部署暂停、重启批准文字可能已过时，不能作为新的产品裁定。

本包没有用户仓库源码，也没有审计修复后的新报告。因此不伪造现有文件结构、精确函数名、新数据库表、已部署版本或已通过测试。GLM 必须以当前源码和运行证据适配，实现锁定行为；遇到无法适配按阻断流程报告。

## 本对话已查验的官方技术资料

### 图片生成

- OpenAI Images 创建接口：https://developers.openai.com/api/reference/resources/images/methods/generate
- GPT Image 2.6 Flare：https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
- GPT Image 2.6 Sunburst：https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst

本对话查验的官方接口已列出 gpt-image-2.6-flare / gpt-image-2.6-sunburst。具体账户访问、格式 preview 和当前参数约束应在实际接入时按官方接口/账户配置核实，不因文档列出型号就假定用户 Key 已有全部权限。生成接口返回的真实数据应解码保存进 M，不能只把响应文本或临时读取地址当原件。

### EmbeddingGemma 2

- Google 模型卡：https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2
- 旧简报所列官方固定 revision：https://huggingface.co/google/embeddinggemma-2/blob/914f7f89142e33e77833254d9c9b90c3cef7303b/README.md

官方模型卡确认其是多模态 embedding，包含文本和图片的共享向量空间。固定 revision 真实存在不等于已核实用户生产加载的版本。实际迁移保持当前已经验证的本地权重/指纹，不能借本包升级模型。

### Qwen3-Embedding-4B

- Qwen 官方模型卡：https://huggingface.co/Qwen/Qwen3-Embedding-4B

这是文本 embedding 模型。复用 M 已有服务和检索基础设施是本方案的架构决定，不是官方要求，也不表示已有存档 scope 已经自动接好。

### Claude prompt cache

- 官方说明：https://platform.claude.com/docs/en/build-with-claude/prompt-caching

缓存要求对应前缀一致，文字、图片、工具/系统设置变化都可能影响缓存。当前窗不删改历史、通知尾部追加、开窗资料冻结，是减少人为破坏缓存的实现选择；不保证所有模型入口与任何时刻均命中，也不把 est 的心跳策略时长当成官方 TTL。

## 术语与不确定性

- 本文“正本”指长期原始媒体与唯一业务写入责任。可重建向量索引、元数据投影、浏览器缓存、流式传输缓冲并不自动成为第二正本；不得利用这个区别长期在 E 保留整套完整原件。
- “真实图片输入”由具体模型发送协议决定。工具结果 JSON 出现媒体引用不代表模型已经收到图像。
- “后台读取原文”不等于把原文额外回读给char；后者本次禁止作为存档前置。
- “移除相册关系”不等于删除仍被原文/作品使用的媒体。
- “不重跑专项审计”不等于免验收；逐批入口、边界、旧路径退出和必要集成验证都必须有证据。
