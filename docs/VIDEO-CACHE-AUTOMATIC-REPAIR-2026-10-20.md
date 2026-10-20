# 视频缓存跨域跳转自动兼容（2026-10-20）

上游不配合调整下载地址时，由服务器上的独立维护程序自动修复已确认的这类缓存失败。模型提交、轮询、结算、实际视频下载和有效期仍由 new-api 执行；不修改 new-api 源码，不向供应商重新提交任务。

## 处理边界

- systemd timer 每 30 秒运行一次，读取最多 25 条候选；默认手工运行仅 dry-run，服务显式传 `--apply`。
- 仅处理 PostgreSQL 中 `SUCCESS`、完成时间在 48 小时内、未记录缓存成功、没有插件执行快照的任务。
- 渠道必须为既有 NewAPI Video（59）或 MiniMax Video（64），真实渠道源站必须与显式配置的 `https://api.kkone.vip` 完全一致。按实际渠道读取，不固定生产 channel ID。
- 上游任务标识必须是 `task_` 加 32 位字母数字；私有源地址必须精确为该任务的 `/video-cache/{upstream_task_id}.mp4`，且失败记录必须完整证明实际跳转到了 `https://video.kkone.vip` 下的同一路径。未知域名、额外查询参数、其他失败和过期任务不处理。
- 使用独立 Prisma client、Serializable 事务，在事务内重新核对任务、源地址、渠道和错误；序列化冲突重新读取，最多重试三次。不能安全保留的 JSON 大整数直接跳过。
- 写入前，先将不含渠道密钥的原始地址及依据持久保存到 root 私有文件（0700 目录、0600 文件、fsync）。只更新 `private_data.upstream_result_url` 和 `video_cache_next_retry_at`；其他字段按事务中最新值保留。
- 修正后由 new-api 原有后台重试取回视频。媒体源与渠道源站不同，new-api 自身会清空渠道认证头，并保留正常的下载安全校验和缓存过期逻辑。

本功能不接收客户传入的任意下载 URL，不调用模型接口，不改变生成成功状态、配额、售价或已有缓存时间。修复任务只读取渠道 id/type/base URL；供应商密钥不会写入审计文件或日志。

## 运行方式

维护镜像由已验证的 Portal 依赖镜像构建，单独运行 Node CLI，不执行 Portal 的 `start.sh` 或任何 migration。Prisma schema 只是已有 new-api 表的映射；其生成配置只有不可连接的占位地址，禁止对生产执行 migrate/db push。

宿主机 launcher 从已有数据库容器配置读取连接资料，在 root 私有运行目录生成一次性凭据文件，只读挂载给短生命周期维护容器；退出即删除。维护容器无公开端口、无 Docker socket、根文件系统只读，限制内存/CPU/进程数，只给审计目录写权限。锁位于持久 state 目录，防止手工执行与 timer 重叠。SIGTERM 和超时会清理本次维护容器。

- 配置：`/etc/llmroute/video-cache-repair.json`（0600）
- launcher：`/opt/llmroute-video-cache-repair/run-video-cache-repair.py`
- state/审计：`/var/lib/llmroute-video-cache-repair/`（0700）
- 一次性凭据：`/run/llmroute-video-cache-repair/`（0700）
- 单次服务：`llmroute-video-cache-repair.service`
- 定时器：`llmroute-video-cache-repair.timer`
- 最近运行摘要：state 下的 `last-run.json`，只包含时间、模式和数量。

排查命令：

```bash
systemctl status llmroute-video-cache-repair.timer --no-pager
journalctl -u llmroute-video-cache-repair.service --since '-10 min' --no-pager
python3 /opt/llmroute-video-cache-repair/run-video-cache-repair.py --config /etc/llmroute/video-cache-repair.json
```

暂停自动兼容使用 `systemctl disable --now llmroute-video-cache-repair.timer`，再等待或停止本次 service。已正确修复的下载源无需撤回；需要撤回单条时必须核对私有审计和当前值，通过 Prisma 事务只恢复该条源字段，不整库覆盖后续业务。

## 验证

- 新增 55 项策略/事务/审计单元测试，覆盖未完成、已缓存、已过期、非登记源站、跨任务地址、恶意地址、凭据不落审计、备份失败拒写、并发字段保留、默认只读和错误不冒充成功。
- 完整测试为 5727 passed / 2 skipped / 0 failed，含真实 new-api 只读 smoke；类型检查通过，lint 为 0 error / 100 个既有 warning，改动文件格式和 `git diff --check` 通过。首次联机测试发现本机 13000 隧道未连接，建立临时独立隧道并在内存中使用当前生产管理员凭据后通过；没有修改原测试断言或用户 `.env`。
- 在独立 PostgreSQL 测试数据库启动与生产完全相同、未修改的 new-api 镜像，完成 20 项真实 Prisma 断言，包含实际 PostgreSQL 序列化冲突、自动重读及未知 JSON 字段保留。
- 隔离环境以一条已有视频的私有媒体能力地址模拟成功任务。维护程序修改源后，new-api 原有后台 worker 自动下载并写入缓存；随后 HEAD 为 200、`video/mp4`、2,626,131 字节，Range 为 206。没有提交任何生成请求。
- 测试期间生产 new-api、PostgreSQL、Portal 的容器身份、镜像和启动时间一致。测试数据库、测试容器和一次性连接资料均已清理。
- 生产 dry-run 成功，候选为 0；原有受影响视频已在前一次人工恢复中取回，详见 [存量视频取回记录](VIDEO-CACHE-RECOVERY-2026-10-20.md)。

首次隔离运行暴露 standalone 镜像未保留 zod/runtime-utils 根依赖链接；只在独立维护镜像恢复既有依赖链接，并添加离线导入/构造检查后通过，没有重新安装依赖或修改线上 Portal 镜像。

## 使用上的限制

自动检查和 new-api 的下载重试均为后台流程，任务生成成功后的文件准备可能稍有延迟；下载完成前公开链接仍可能暂时 404，需要稍后重试。当前兼容的是上述已验证源站/媒体域名组合，未把任意跨域跳转放开。未来更换供应商域名、new-api 表结构、错误格式或缓存机制时需要重新核验，不能承诺所有未知错误均可自动修复。

发布与最终完整检查结果在安装后补充；应用业务容器不需要重建或重启。
