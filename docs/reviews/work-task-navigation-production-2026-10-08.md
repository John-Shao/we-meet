# Work 新建任务与导航历史：生产发布（2026-10-08）

生产前端已部署目标输入器和导航下半部分的“最近任务”。发布遵循**本地构建、远程发布**：在本机 WSL 构建并推送镜像，生产服务器仅拉取固定摘要的镜像并滚动更新 `meet/meet-frontend`。

## 发布版本与范围

- 最终源码：`6de1358fa752360493878a99d18348db517df023`；[发布 CI 37754846680](https://github.com/John-Shao/we-meet/actions/runs/37754846680) 四项检查通过。
- 镜像标签：`jusi-cn-guangzhou.cr.volces.com/we-meet/meet-frontend:6de1358fa`。
- 实际运行镜像：`jusi-cn-guangzhou.cr.volces.com/we-meet/meet-frontend@sha256:cd698bf771256e45ed697307dae2886aa5144ca2b0d11e1327763010ee804ad4`。
- 构建环境：本机 WSL Ubuntu-22.04，`linux/amd64`、`frontend-production` target、运行用户 `nginx`。构建上下文来自该提交的 `git archive`，包含前端、设计 tokens、Docker ignore 和入口脚本；本地未提交文档和私有验收文件未进入镜像。
- 访问地址：[生产 Work 页面](https://meet.we-meet.online/work?view=new)。

中心区域显示任务目标输入器、材料入口、补充设置和快捷目标；任务历史进入工作导航的下半部分，未开放功能默认收在“更多”中。历史条目保留来源、状态、当前项和分页；当前展示本机或云端执行页面对应的历史，尚未合并所有办公模块的任务。

本次仅更新前端 Deployment 的镜像字段，UID 保持不变，其他 **22 个 Deployment/CronJob** 的 UID 和完整 spec 前后逐项相等。业务镜像保持 `ffb1c5890`，独立 Gateway/Pi 保持既有 0.3.6 版本；灰度、审批规则、模型配置和数据库未调整。未运行 Helm upgrade 或数据库迁移，本次没有创建新的 Helm release revision；后续常规发布需使用现有读取 live image 的发布脚本，保持此次前端摘要。

## 验证与修复

最初从已通过 CI 的 `cdde7c4e2` 发布布局。真实生产浏览器测试发现窄屏下点击云端历史任务能够切换任务，但导航没有自动收起：同步路由更新与原生 DOM 事件委托之间存在时序问题。改为 React 门户内的事件冒泡处理，并增加“切换任务后关闭窄屏导航”的回归测试；重新本地构建、通过 CI 后发布最终 `6de1358fa`。先前测试未通过的结果未计为最终验收成功。

| 验证               | 结果                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| 本地 Work 页面测试 | 5 个文件、39 项通过，涵盖本机/云端任务、审批、重试、复核及新导航回归                                     |
| 静态检查           | 修改文件的 ESLint、Prettier、`git diff --check` 通过                                                     |
| 本地生产镜像       | 构建、推送成功，架构/用户/源码标签已核验                                                                 |
| 发布 CI            | 前端、后端、桌面和部署保护全部通过                                                                       |
| 生产部署           | 新 Pod Ready=1，实际 imageID 与固定摘要一致                                                              |
| 公网静态资源       | index、JS、CSS 和字体逐文件与运行 Pod 内容一致                                                           |
| 真实生产账号 API   | 核验演示账号身份后，通过正式业务 API 加载已有任务；未 mock API                                           |
| 实际页面交互       | 导航下半部分历史、当前任务高亮与已有结果、草稿保留、快捷目标只填充、Esc 关闭材料菜单、生成禁用状态均通过 |
| 屏宽               | 1600、1024、768、390 px；布局稳定后无页面横向溢出，390 px 历史选中后导航关闭                             |
| 服务健康           | 后端与 AI 的 heartbeat/lbheartbeat 均为 200；后端、Celery、Gateway 就绪                                  |

演示账号当前有两条云端登记的本机历史。本轮未创建任务、重新生成或请求 Pi 复核；Work 写请求和供应商调用均为 **0**。此前本地合成 UI 验收另外覆盖八条默认历史、显示更多、远程待办准入及本地目录授权；这些合成验证与本轮真实生产读操作分别记录。

浏览器验收通过 OTP API 在内存中引导会话，未覆盖扫码/短信输入界面的登录体验；令牌未写入验收文件，临时浏览器上下文结束即关闭。截图和详细构建日志保留在本机忽略目录 `.work-acceptance/ui-new-task/`，机器回执见[发布回执](work-task-navigation-production-2026-10-08.json)。

## 回退与客户端边界

两次发布均使用共用维护锁和 UID、resourceVersion、完整 spec 的条件补丁，生产私有快照位于：

- `/var/lib/we-meet-work-maintenance/cohort-cdde7c4e2-layout/`：原前端与首次布局发布快照。
- `/var/lib/we-meet-work-maintenance/cohort-6de1358fa-layout/`：修复前、修复后及最终健康回执；目录 0700，私有文件与回退脚本 0600。

如需回退，维护人员在生产执行：

```bash
sudo python3 /var/lib/we-meet-work-maintenance/cohort-6de1358fa-layout/rollback.py
```

脚本先锁定现场，并校验当前资源 UID 和完整 spec 仍等于已发布快照，再恢复本轮发布前的前端 `sha256:266fa1b7d53869b35f348782496510b32fabfe13df0b0db9644927c892665021`，等待 Ready 并核验旧公网 index 摘要。现场已变更时拒绝覆盖；本轮未实际执行回退。回退仅涉及前端，不重放任务或修改成果。

**此次没有重新分发 Windows 安装包或 Android APK。** 已安装的桌面 App 使用内置 renderer，更新生产网页不会自动更新该安装包中的布局。桌面用户需要安装包含新 renderer 的客户端版本；原生本地审批与工作空间行为已由本地回归验证，但本轮不声称完成新安装包交付或 Android 原生页面验收。

随后按用户要求，已另外构建包含上述布局的 Windows `0.4.0-delivery.5` 内部安装包，见[桌面重构建记录](work-desktop-layout-delivery-2026-10-08.md)；这不改变本篇生产网页发布的验收范围。
