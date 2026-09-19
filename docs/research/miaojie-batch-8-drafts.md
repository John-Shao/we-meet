# 第八批：Web 记录详情的校对草稿

单行编辑器原先能保留冲突草稿，但父级记录 revision 改变会重新挂载原文列表，导致局部状态丢失。修复把编辑状态、草稿、开始编辑时的 correction revision、等待及失败状态放到当前记录的内存作用域；列表重建或切换页签不丢失该状态。

作用域隔离 viewer / record，详情读取失败或退出时卸载，原文权限改变及原文 401/403/404 时清除。晚到的异步回调通过作用域代次检查，不能恢复已经清除的草稿。没有使用 localStorage、IndexedDB 或服务端草稿表。取消后重新编辑仍读取最新原文；失去编辑权限后禁用保存。

本批只覆盖 Web 记录详情中的上传及录音原文阅读组件。没有承诺刷新整个浏览器、关闭页面后恢复草稿，也没有以保留草稿为由展示已经拒绝读取的原文。ASR 替换后消失的段落不会强行复活显示。

验证：TranscriptSegment 15 项、CaptureTranscriptionPanel 30 项、MeetingRecordWorkspace 15 项，共 60 项通过；包含真实父级 revision 刷新、行重建期间的冲突、撤权后晚回调和禁止编辑后保存。TypeScript 与改动文件 ESLint 通过。Android 同类列表状态另行检查，本批没有 Android 变更。
