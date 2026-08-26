# 任务模块浏览器 E2E

任务模块使用 Playwright Chromium 验证真实前端、Django、数据库和 Keycloak 登录链路。外部 IM 最终送达不属于浏览器用例，由后端通知测试覆盖。

## 首次准备

安装前端依赖和 Chromium：

```bash
cd src/frontend
npm ci
npx playwright install chromium
```

按项目开发说明启动完整应用，确认以下地址可访问：

- 前端：`http://localhost:3000`
- API：`http://localhost:8071/api/v1.0/config/`
- Keycloak：`http://localhost:8083/realms/meet/`

测试不会启动、停止或重置本地容器，也不会清空开发数据库。每条用例创建唯一命名的数据，并在结束时删除自己创建的任务。

## 运行

在仓库根目录执行：

```bash
make test-e2e
```

或在 `src/frontend` 执行：

```bash
npm run test:e2e
npm run test:e2e:headed
```

可用环境变量：

- `E2E_BASE_URL`：前端地址，默认 `http://localhost:3000`。
- `E2E_USERNAME`：Keycloak 用户名，默认 `user-e2e-chromium`。
- `E2E_PASSWORD`：Keycloak 密码，默认 `password-e2e-chromium`。

登录状态仅写入被 Git 忽略的 `src/frontend/playwright/.auth/`，不会提交 cookie 或令牌。失败报告位于 `playwright-report/`，截图、视频和 trace 位于 `test-results/`。

## 当前覆盖

核心用例覆盖：OIDC 登录、创建独立任务、默认本人负责、头像与姓名显示、列表内优先级和截止日期编辑、详情开始日期编辑、刷新持久化、完成任务和已完成视图。

首期仅运行 Chromium，单 worker 串行执行。Firefox、WebKit、多用户协作、附件、外部 IM 和会议行动项转换不在当前浏览器用例范围内。
