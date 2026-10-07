# dsh / Pi 真实容器回归

将上一批 Git 忽略目录中的手动验收流程补成 [仓库测试](../../deploy/aliyun/test_work_node_docker.py)，运行方式见 [部署说明](../../src/work-agent/DEPLOYMENT.md)。测试默认跳过真实 Docker 操作；显式开启时要求本地 context、预期 daemon、三个不可变镜像和两个包版本。未部署服务、调用模型或修改业务配置。

## 验证结果

实际运行环境：Windows 上的 Docker Desktop Linux daemon `docker-desktop`，context `desktop-linux`。三种镜像复用 [上一批固定 digest](work-node-check-2026-10-07.md)。为每种 engine 创建全新状态目录，使用与 Gateway 一致的绝对路径挂载和 worker 隔离参数。

- 共 **13 项通过**：原节点边界 9 项、夹具边界 2 项、真实 dsh/Pi 容器各 1 项。默认关闭真实测试时为 11 项通过、2 项明确跳过。
- 实际 Pi `1.0.4` 与 dsh `0.1.5rc1` 均通过只读检查和 Desktop 显式端口转发探测，核验挂载往返、401/200 鉴权、无供应商凭据和只读根目录。
- 两种实际镜像均注入错误版本 `0.0.0-invalid-fixture`，均拒绝并返回 `probe_failed_runtime`；失败后所属容器和文件仍被清理。
- Desktop host-network 仍返回 `probe_failed_broker_route`，在回执中单列，未宣称完成原生 Linux runner 验收。
- 新夹具边界检查覆盖缺少显式参数、远程 Docker socket、错误 daemon、可变 tag 在创建资源前拒绝；helper 容器退出失败不得当作成功，仍尝试按所属身份清理。
- Ruff 检查、格式检查与 Git diff 检查通过。所有创建容器均禁止自动拉取镜像。

原始自动回执位于 Git 忽略的 `.work-acceptance/work-node-docker-regression-20261007/final/`，每种 engine 一份；[公开摘要](work-node-docker-regression-2026-10-07.json) 从这两份回执核对生成。报告只在目录清理成功后写入，合成 Inbox 标记内容在测试前后保持一致。结束后按所属 label 查询剩余容器为 0。模型调用数 0；没有 agent CLI 执行、模型 key 读取、已有容器变更或集群发布。

## 下一环境边界

本批解决镜像升级后可重复复验的问题。专用 Linux 节点的真实主机网络、状态备份和防火墙仍需目标环境提供；集群 context/namespace、镜像仓库、TLS/Secret 和部署后 HTTPS/合成任务仍待验收。Desktop 转发通过不改变这一边界。
