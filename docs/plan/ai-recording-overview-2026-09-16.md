# AI 录音概览页（Web / Android）

AI 录音一级页统一为录音功能入口和历史录音，原录音功能页移至二级。打开一级页只查询录音历史，不申请麦克风或启动采集。

## Web 路由与行为

- `/meeting/recording`：录音入口和最近 10 条已结束录音，按服务端发生时间倒序。
- `/meeting/recording/capture`：原录音工作区，保留录制、暂停、恢复、翻译、保存等功能。
- `/meeting/recording/history/:recordId`：录音详情，展示标题、发生时间、保留模式和会议实录 / 智能纪要链接，不加载音频、转写或纪要正文。
- “更多”指向 `/meeting/notes?source_type=audio_recording`；会议实录中的录音和恢复入口直接打开二级录音工作区。
- 历史接口复用 `meeting-records/?scope=recent&source_type=audio_recording&is_ongoing=false`，先在服务器筛选再分页，不要求已有纪要。
- 查询按登录账号隔离，读取错误隐藏旧结果并提供重试；详情链接遵守服务端读取能力。录音二级路由保持左侧 AI 录音导航选中。

## 更新部署

Android 对应提交 `3752df1f`，重新构建安装 App。Web 更新前端镜像；本批无需后端、数据库迁移、模型配置或 IM SDK 发布。

在部署服务器更新 Web：

```bash
bash deploy/aliyun/release-meet.sh frontend
```

验证录音入口、返回、空历史、最近 10 条、更多筛选、详情权限及两个详情链接。保留原录音页的录制 / 暂停 / 恢复 / 保存回归。

## 本地验证

- Android：21 项仓库单元测试、4 项新界面测试和设计规范检查通过。
- Web：新概览 / 详情、侧栏导航、原录音、会议实录列表和实录工作区共 30 项测试通过。
- Web 生产构建、TypeScript、ESLint、JSON 与颜色检查通过。
