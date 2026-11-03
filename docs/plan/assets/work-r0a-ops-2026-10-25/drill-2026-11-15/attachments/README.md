# 附件目录

按 `<step-id>-<kind>.<ext>` 命名，`verdict.json` 的 `evidence[]` 里填相对路径（如 `attachments/D2-5-log.txt`）。

建议 kind：
- `log` 命令输出 / journal 截取（worker、server、psql、systemctl）
- `sql`  查询语句 + 结果（贴文本，含时间戳）
- `describe` Temporal `workflow describe` / `taskqueue describe` 输出
- `png`  仪表盘截图（Prometheus/Grafana，若 #35 后已接）
- `diff` 前后状态对比（worker 版本 tag、run state 转换）

命名示例：
- `P1-log.txt`（环境快照采集）
- `D1-4-describe.txt`（在途 workflow 未丢）
- `D2-5-log.txt` + `D2-5-sql.txt`（新 run 由 v2 领 + operation 逐条）
- `C28-4-sql.txt`（execution_enabled / operator_suspended 落库 + access_epoch+1）

单文件超过 ~1MB 用 `git lfs` 或压缩为 `.gz`；**不**把密钥、口令、真实用户内容贴进附件。
