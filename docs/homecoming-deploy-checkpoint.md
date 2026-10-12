# 欢迎回家登录迁入检查点（完成）

目标：把已验证的 V19 登录接入放入本机 estómago。
已完成：迁入源码与原始素材，图片和字体哈希一致；Mac 隔离全量 98/98 测试文件通过；正式目录已快进至 c523fe9，服务已重启，登录入口与资源均正常。
验证限制：类型检查仍报原始基线的 Siren adapter BlobPart 错误；浏览器控制工具连接失败，未补实机视觉验收。
下一步：无待迁入文件；可从既有 estómago 入口使用。
涉及：apps/host/src/server/http.ts、apps/web/src、tests、README.md。
状态：完成。GitHub 未推送。
