# Installation
If you want to install La Suite Meet you've come to the right place.
Here are a bunch of resources to help you install the project.

## Kubernetes
La Suite Meet maintainers use only the Kubernetes deployment method in production, so advanced support is available exclusively for this setup. Please follow the instructions provided [here](/docs/installation/kubernetes.md).

For a local Windows + Docker Desktop walkthrough (kind + Tilt, in Chinese), see [docker-desktop.md](/docs/installation/docker-desktop.md).

## Docker Compose
We understand that not everyone has a Kubernetes cluster available, please follow the instructions provided [here](/docs/installation/compose.md) to set up a docker compose instance.
We also provide [Docker images](https://hub.docker.com/u/lasuite?page=1&search=meet) that can be deployed using Compose.

## Scalingo

La Suite Meet can be deployed on Scalingo PaaS using the Suite Numérique buildpack. See the [Scalingo deployment guide](./scalingo.md) for detailed instructions.

## Other ways to install La Suite Meet
Community members have contributed alternative ways to install La Suite Meet 🙏. While maintainers may not provide direct support, we help keep these instructions up to date, and you can reach out to contributors or the community for assistance.

Here is the list of other methods in alphabetical order:
- Nix: [Packages](https://search.nixos.org/packages?channel=unstable&show=lasuite-meet&query=lasuite-meet), ⚠️ unstable
- Yunohost: [Packages](https://github.com/YunoHost-Apps/meet_ynh), ⚠️ under construction (for small instances only)

> [!TIP]
> Feel free to make a PR to add ones that are not listed above

## Cloud providers
Currently, no cloud providers are listed for deploying La Suite Meet.
> [!TIP]
> Feel free to make a PR to add ones that are not listed above

## we-meet 自部署文档(中文 / fork-specific)
本 fork 的实际部署与发布文档:
- [阿里云生产部署(首次安装)](./aliyun.md)
- [阿里云日常发布 Runbook(改代码后上线)](./aliyun-release-runbook-cn.md) —— build+push → 何时需 helm upgrade / rollout / migrate 的判断表,含实例
- [三方日历同步删除部署步骤](../extensions/三方日历同步删除_部署步骤.md) —— `0098` 破坏性迁移的备份、专用发布顺序、Schema 验收和联合回滚
- [通讯录拼音索引部署步骤](../extensions/通讯录拼音索引_部署步骤.md) —— 新依赖 `pypinyin`（镜像构建时 `uv sync --locked` 装，**不加**到 deploy 脚本）+ `0143` 回填存量用户拼音列 + 全员列表顺序变化的风险说明
- [通讯录排序键修正部署步骤](../extensions/通讯录排序键修正_部署步骤.md) —— 后续增量：`0144` 把「`#` 桶排最后」编进排序键（`en_US.utf8` 忽略标点，`~` 前缀无效）、重算存量键、换复合索引；含「迁移窗口漂移行」的检查与收敛命令
- [通讯录拼音搜索部署步骤](../extensions/通讯录拼音搜索_部署步骤.md) —— 再后续：`0145` 加 `User.search_key`（全拼 + 首字母缩写），`q=ye` / `q=ylx` / `q=夜` 都命中「夜来香」；无新依赖、无索引（实测 5000 人名册 ~11 ms，与老查询同量级），前端/App 只改占位文案
- [京东云迁移 Runbook(meet 迁云 + 旧机改 Docs)](./jdcloud-migration-runbook-cn.md) —— 把 aliyun.md §十四 + docs-server.md 合成的连贯执行清单,含备案接入 / PG 迁移 / DNS 切换 / 回滚预案
- [本地开发(Windows + 国内,Tilt/kind)](./local-dev-tilt-windows-cn.md)
- [IM 跨仓发布「三波曲」](./im-release-three-waves-cn.md) —— 改动同时涉及 jusi-light-im(IM 后端)+ `@jusi/light-im-sdk` + we-meet 时的协调发布流程(① jusi → ② SDK → ③ we-meet),含 lockfile integrity / `tsc -b` / 镜像缓存等踩坑清单
