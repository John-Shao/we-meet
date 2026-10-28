## 概要

彻底移除旧 Python Work 服务：

- 删除 `src/backend/work` 整个 Django app（API、模型、任务、编排、运行时、测试）
- 移除 `/work/v1`、`/work/metrics`、`work` app 注册/中间件/Temporal 设置；数据库 `search_path` 去掉 `work`
- 删除前端 `/work` 路由、导航入口、`features/work` 与文案 key
- CI：删除 Django Work 迁移/冒烟 job，保留 Host 目录与会话测试；去掉 `src/backend/work/**` 路径
- 依赖：移除 `prometheus-client` 与 `legacy-work`(temporalio) extra，`uv.lock` 重生成

## 数据

发布完成后直接 `DROP TABLE public.work_* CASCADE` 并删除 `django_migrations` 中 `app='work'` 记录（12 张表、约 32 行）。Work 新库在 Work ECS，不受影响。

## 测试

- [x] Production/Build 设置加载通过（`manage.py check`）
- [x] CI YAML 解析
- [ ] Work R0a gates（Host 测试 job）
- [ ] meet Workflow `test-front`/`test-back`
- [ ] 发布后旧路由 404、数据表清空、Host/同步正常
