# 第十三批：生产直传签名 500 修复

2026-09-20，用户提供已部署版本 `f2e7f3cd4`、生产地址与演示身份及两个媒体样本后，开始真实接口验收。凭据和媒体签名不写入报告。

## 发现与修复

生产上传能力接口返回可用，但 `POST recording-uploads/upload-url/` 使用有效 m4a 声明两次返回 HTML HTTP 500，发生在传输文件前。

`presign_direct_upload` 在没有事务的请求中调用 `select_for_update()`。新增 `django_db(transaction=True)` 回归，在真实 PostgreSQL autocommit 下先复现 `TransactionManagementError: select_for_update cannot be used outside of a transaction`，然后为服务入口增加显式原子事务。原有测试的外层事务掩盖了这一问题。未获取生产堆栈，生产 500 与此路径的关联仍需部署后复测确认。

## 验证

- 直传测试：13 项通过，包含新增的无请求事务回归。
- Ruff：测试文件通过；服务文件沿用 3 处既有 PLR0913 排除，其余检查通过。
- 普通上传作为验收备用路径：授权音频上传 202，真实 ASR 成功，18 段原文；附件下载 200、原文件 SHA-256 一致；后段 Range 206，1024 字节与 Content-Range 正确。
- 浏览器连接连续失败，尚未取得 UI 状态，以上不能代替 Web/Android 页面验收。

本批不需要迁移，部署后须从实际上传入口重新验证签名与对象存储 PUT；本地修复没有改变当前生产版本。
