# 第十五批：直传 PUT 签名头修复

## 生产复测发现

用户已部署 `a5f314c33` 后端/Web，Helm revision 372。2026-09-20 约 10:00 开始复测：直传签名从 500 恢复为 200，但严格使用接口返回的 `headers` 发送 PUT 时，对象存储返回 403 `SignatureDoesNotMatch`，消息为 `Not all the signed headers are found in the request.`。

签名中的 SignedHeaders 为 `content-length;content-type;host;x-amz-acl`。接口只返回 Content-Type，漏了签名包含的私有 ACL 头。补齐 `x-amz-acl: private` 后，同一授权样本 PUT 立即成功，定位到确定原因。

## 修复与验证

- 后端在签名响应中同时返回 Content-Type 和 x-amz-acl。Content-Length/Host 由浏览器或 HTTP 客户端根据请求生成，不要求浏览器脚本设置受限请求头。
- Web、Android 现有实现均透传返回的 headers，无需修改客户端行为。Web 测试补充 ACL 头透传断言，后端测试将返回头与签名 ACL 对齐。
- PostgreSQL 直传 17 项测试通过；Web 上传 14 项测试及变更文件 ESLint 通过；后端测试文件 Ruff 通过，服务文件继续仅排除既有 PLR0913。
- 生产 CORS OPTIONS 返回 200，允许来源 `https://meet.we-meet.online`，允许 PUT 及 `content-type, x-amz-acl`，不需要额外修改存储权限或 CORS 配置。
- 音频：在验收 HTTP 请求中手动补齐头后，PUT 200、登记 202；重复登记同一记录；ASR succeeded；标题/原文件名保留；附件下载 200、大小及 SHA-256 与本地一致。
- 视频：同样补齐头后签名 200、PUT 200、登记 202；ASR succeeded，标题/原名保留，下载附件名、19,855,680 字节及 SHA-256 与本地一致。

以上为部署前补齐请求头的诊断证据。2026-09-20 用户已部署 backend `2eb3482c6`（revision 373），约 10:30 已严格使用接口原样返回的 headers 完成两样本签名/PUT/登记/转写及下载哈希验收，详见 [发布验收](miaoji-release-acceptance.md)。本批生产接口阻断已关闭；浏览器连接仍失败，页面上传/播放/草稿与 Android 实机验收尚未通过。
