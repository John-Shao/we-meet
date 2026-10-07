# Docker runner 节点检查

新增 [节点检查工具](../../deploy/aliyun/check-work-node.py) 和 9 项回归，为 dsh/Pi 独立发布补齐 daemon 身份、不可变镜像、同路径状态目录和 worker 到 ModelBroker 路由的验收入口。使用方式见 [部署说明](../../src/work-agent/DEPLOYMENT.md)。默认只读；`--probe-container` 显式启用合成容器探测，不启动 agent 或调用模型。

## 实测结果

实际使用 Docker Desktop Linux daemon `docker-desktop`。检查脚本在固定 Gateway 镜像中运行，挂载本地 Unix Docker socket；宿主机与检查容器使用相同绝对状态路径。每次测试创建全新 `/var/lib/we-meet-node-probe-<随机值>`，已有业务状态目录和容器均未修改。

| 模式 | Pi 1.0.4 | dsh 0.1.5rc1 |
| --- | --- | --- |
| 默认只读：本地 socket、daemon、镜像 digest/平台、目录权限 | 通过 | 通过 |
| Docker Desktop host-network 合成探测 | 拒绝：`probe_failed_broker_route` | 拒绝：`probe_failed_broker_route` |
| Docker Desktop 显式端口转发合成探测 | 通过 | 通过 |

端口转发夹具使用 bridge 网络的检查容器，`--publish 127.0.0.1:PORT:PORT`，检查脚本传入 `--probe-port PORT`；worker 继续使用当前生产参数的 `host.docker.internal:host-gateway`。两种实际 worker 均核验运行包版本、任务目录文件往返、匿名 401/临时鉴权 200、只读根目录和无供应商凭据。没有运行 agent CLI 或真实 provider 请求，模型调用数为 0。

固定镜像：

- Gateway：`sha256:852986495e3328a64bb9634a7b3dfc8fdf40e2fd50c128ba4448c3ac37f72cd0`。
- Pi：`we-meet-work-agent@sha256:f4a6e12494cea11ce3cc0c1100ceb84a5742f83dcd0fd1dda09d7670df89c5cc`。
- dsh：`we-meet-work-agent@sha256:2bc6c0d3564961e3baac7482b136836e1fec2c7bd79e2eeda270b57494401031`。

原始只读、host-network 失败和端口转发通过回执及本机运行夹具保存在 Git 忽略的 `.work-acceptance/work-node-check-20261007/`；[公开 JSON](work-node-check-2026-10-07.json) 保留结果与验收边界。所有探测容器、检查容器及新建状态目录均已清理；按所属标记与名称查验剩余探测容器为 0。

## 回归与边界

9 项单元回归通过：拒绝错误 context/daemon/digest/架构与镜像内凭据；已有 Inbox 文件保持原样；创建容器丢失应答与启动失败仍清理所属资源；拒绝清理所属标记或镜像不符的容器；运行版本不符拒绝；目录与符号链接边界；默认只读、错误脱敏及报告不覆盖；Docker 原始诊断不外泄；失败阶段只接受固定白名单且清理仍执行。Ruff 检查及格式检查通过。

这份回执验证的是本机实际镜像与明确标注的 Desktop 转发夹具，**原生 Linux runner 的主机网络验收尚未完成**。专用 Kubernetes 节点、持久状态备份、节点防火墙、registry 拉取、provider 可用性和部署后 HTTPS/合成任务仍需在目标测试环境核验。没有部署 release、打开生产 reviewer 或修改业务配置。
