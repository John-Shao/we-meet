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
npm run test:e2e:responsive
```

桌面 Web 视觉基线需要经人工确认后更新：

```bash
npm run test:e2e:update-responsive
```

桌面 Web 视觉回归覆盖 `1024 x 768`、`1366 x 768` 和 `1600 x 900` 列表，并在 `1439/1440px` 两侧验证全屏详情与右侧详情面板切换。Web 产品验收最小宽度为 `1024px`，更小的移动设备不属于 Web 适配范围，由移动 App 承接。桌面基线位于 `e2e/tasks.responsive.spec.ts-snapshots/`。

可用环境变量：

- `E2E_BASE_URL`：前端地址，默认 `http://localhost:3000`。
- `E2E_USERNAME`：Keycloak 用户名，默认 `user-e2e-chromium`。
- `E2E_PASSWORD`：Keycloak 密码，默认 `password-e2e-chromium`。

登录状态仅写入被 Git 忽略的 `src/frontend/playwright/.auth/`，不会提交 cookie 或令牌。失败报告位于 `playwright-report/`，截图、视频和 trace 位于 `test-results/`。

## 当前覆盖

桌面核心用例覆盖：OIDC 登录、创建独立任务、默认本人负责、头像与姓名显示、列表内优先级和截止日期编辑、详情开始日期编辑、Ctrl/Cmd+K 任务搜索及创建人/负责人/状态/截止日期筛选、搜索结果详情深链与刷新持久化、完成任务和已完成视图；重复任务场景还会创建每日规则、完成首个实例，并通过真实 API 确认只生成一个序号为 2 的后续实例。

桌面视觉用例通过真实 API 创建固定清单、分组和父子任务，验证 1024、1366、1439、1440 和 1600 像素宽度下的列表层级、筛选区、全屏详情、侧栏详情及子任务内容。动态创建时间在截图中统一遮罩，避免时钟变化造成假失败。

当前运行桌面功能与桌面响应式视觉两个 Chromium 项目，单 worker 串行执行。低于 `1024px` 的小屏不提供 Web 降级实现，也不纳入浏览器回归；Firefox、WebKit、多用户协作、附件、外部 IM 和会议行动项转换不在当前浏览器用例范围内。
