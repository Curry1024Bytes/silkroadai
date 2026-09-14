# new-api SSH 隧道慢：诊断与修复（2026-09-11）

operator 明确批准执行后，已修复 VPS 的 BBR 持久配置并重建 Mac 的 `llmroute-newapi` 隧道。
`http://127.0.0.1:3000/` 可用，实际 SSH TCP 已确认使用 BBR。正式隧道同一脚本三轮中位耗时
从约 6.56 秒降至 0.92 秒，约快 7 倍；这是短时下载测量，不是全部页面响应时间的保证。

## 故障证据

- VPS 本机访问 new-api `/api/status` 约 1–7 ms；经原隧道约 0.46–0.48 秒。CPU、内存和负载未见瓶颈。
- 旧隧道为 CUBIC，`cwnd` 曾降至 2–3；累计重传字节约占已发送字节 11%–12%。这不是精确的线路丢包率。
- `tcp_bbr` 模块已加载，但实际默认算法是 `cubic`，默认队列是 `fq_codel`。
- `/etc/sysctl.d/99-llmroute-bbr.conf` 是一个目录，内部有两个配置文件；sysctl 配置未按预期加载。
  目录时间在 8 月 4 日，早于本次应用发布。未查明是谁或哪个操作生成，不能归因于本次发布。
- 因此，本次主要瓶颈是 VPS 到本机的传输链路及其拥塞控制表现。服务器算力正常并不等于服务器网络配置无关。

## 执行和测速

先保留原 3000 隧道，建立独立 18082 隧道测 CUBIC；再仅临时启用 BBR、重建测试隧道。
用实际 SSH 源端口关联服务端 `ss -tinp`，分别确认 CUBIC 和 BBR，避免只根据全局 sysctl 推断。

全部小脚本测试请求同一资源 `/static/js/vendor-ui-primitives.b17b3046c5.js`，使用压缩下载，
每次 HTTP 200，线上传输 110270 字节；curl 丢弃内容，不经浏览器缓存。

| 阶段                | 隧道                | 三次耗时（秒）        | 中位数（秒） |
| ------------------- | ------------------- | --------------------- | ------------ |
| 调整前交替测试      | 原 3000，CUBIC      | 5.890 / 6.557 / 6.695 | 6.557        |
| 调整前交替测试      | 新 18082，CUBIC     | 1.705 / 5.103 / 7.778 | 5.103        |
| 临时 BBR 后交替对照 | 原 3000，仍为 CUBIC | 7.872 / 6.558 / 3.715 | 6.558        |
| 临时 BBR 后交替对照 | 新 18082，BBR       | 1.810 / 0.827 / 0.635 | 0.827        |
| 持久化并切换后      | 正式 3000，BBR      | 0.994 / 0.813 / 0.916 | 0.916        |

交替对照中 BBR 约快 8 倍；重建 CUBIC 连接本身没有稳定解决慢的问题。正式 3000 的
`/static/js/index.4421e6b3b1.js` 另测一次：HTTP 200，传输 978628 字节，耗时 1.165 秒。
使用 `ssh -O exit` 正常关闭旧 master，再启动同一别名；重连操作约 3.36 秒。

## 当前配置与影响范围

`/etc/sysctl.d/99-llmroute-bbr.conf` 现为普通 0644 文件，仅包含注释和：

```text
net.ipv4.tcp_congestion_control = bbr
```

`/etc/modules-load.d/llmroute-bbr.conf` 的 `tcp_bbr` 保持原样。通过 `sysctl -p` 定向加载，
并检查 `systemd-analyze cat-config sysctl.d`，确认合并配置的最后一项为 BBR，没有被后续覆盖。
默认 `fq_codel` 和 `tc -j qdisc show` 的全部活动队列与备份一致。未执行全局 sysctl 重载。

BBR 是宿主机 TCP 默认设置，影响符合该默认值的新连接；既有连接不会因为改默认值自动切换。
本次通过实际 SSH TCP 验证，未重启或重载 sshd。未重启服务器，因此未声称完成整机重启后的验收。

## 验收结果

- new-api `/api/status` 返回正确 JSON；本机指定 `NEWAPI_BASE_URL=http://127.0.0.1:3000`，
  `client.smoke.test.ts` 三项全部通过。没有执行收费模型请求。
- 主站和 www 登录页均 HTTP 200；公网 API 假 Key 为 401；Anthropic OPTIONS 预检为 204。
- Portal、PostgreSQL、new-api、MySQL 四个容器的 ID、镜像、启动时间、重启次数均未变化，全部运行。
- 生产 `.env` 哈希、VPS Git SHA 均与执行前一致。未修改应用源码、new-api 源码、数据库、Nginx 或 Cloudflare。
- 独立 18082 测试隧道已正常关闭；正式 3000 保留。

这是网络配置维护，无须重建应用或重复完整应用测试。文档记录在 `dev`，本次不推进应用发布分支。

## 备份与回退

服务器备份目录：`/opt/backups/llmroute-network/20260911-064445/`（0700）。

- `network-config-before.tar.gz`：原配置归档，0600，已检查完整性。
- `state.json`：原参数、配置哈希、队列和业务容器基线，0600。
- `misplaced-sysctl-directory/`：完整保留的原错误目录，未覆盖内部文件。
- `restore-network.py`：0700，语法检查通过，尚未执行。执行前核对当前配置和备份哈希，
  将默认值恢复为 cubic，并恢复原目录结构；它是恢复原状态的应急措施，不是推荐配置。
- `restore-runtime.sh`：仅恢复运行时 cubic 的早期应急脚本，不会回退持久配置。

需要完整回退时，在 VPS 执行：

```bash
python3 /opt/backups/llmroute-network/20260911-064445/restore-network.py
```

然后在 Mac 正常关闭并重建相关隧道，再核对实际 TCP 算法。回退默认值也不会改变既有连接的算法。
如果配置或备份已被其他维护改动，脚本会停止，须先人工核对，不能强行覆盖。

## 后续连接方式

日常连接确保配置中的端口转发存在（2026-09-14 修正）：

```bash
if ssh -O check llmroute-newapi >/dev/null 2>&1; then
  ssh -O forward -o ExitOnForwardFailure=yes llmroute-newapi
else
  ssh -fN -o ExitOnForwardFailure=yes llmroute-newapi
fi
curl --noproxy '*' --fail --max-time 10 http://127.0.0.1:3000/api/status
```

需要重连时：

```bash
ssh -O exit llmroute-newapi
lsof -nP -iTCP:3000 -sTCP:LISTEN
# 确认无监听后：
ssh -fN llmroute-newapi
ssh -O check llmroute-newapi
```

不要先 `rm` control socket：删文件不会关闭旧连接。本机 SSH 配置没有被修改。
线路仍有约 0.5 秒的请求延迟，BBR 缓解吞吐退化，并不会消除物理距离和网络波动。

原始诊断和测速记录位于 operator Mac 的 `/tmp/llmroute-bbr-20260911/`；持久审计以本报告和服务器备份为准。

## 2026-09-14：master 存在但没有端口转发

本次是本地转发缺失，不能归为前述 BBR/吞吐问题。`ssh -O check` 返回 `Master running (pid=22713)`，
该进程有到 VPS:22 的已建立连接，但 `lsof` 没有 3000 LISTEN；curl 立即 connection refused。
SSH 配置仍正确包含 `127.0.0.1:3000 -> 172.17.0.1:3000`，不是配置丢失。

旧推荐命令只检查 master，成功后会跳过 `ssh -fN`，因此无法修复这种状态。部署命令使用同一别名和
`ClearAllForwardings=yes`；master 启动于 10:53:21，与发布切换命令时间吻合。该选项会在创建新主连接时
清除转发，仍可留下 ControlPersist master；其存在不能视为隧道可用。

执行 `ssh -O forward llmroute-newapi` 后，同一 PID 开始监听 127.0.0.1:3000；再次执行退出码仍为0。
实际 `/api/status` 为 new-api rc.23 JSON、HTTP200，约0.337秒；127.0.0.1与localhost首页均200、约0.33秒；
首页引用的一项脚本200、339927 bytes、约1.387秒。未关闭master、删除socket、修改SSH配置或重启线上服务。

今后无转发的运维 SSH 命令同时使用 `-o ControlPath=none -o ControlMaster=no -o ClearAllForwardings=yes`，
与用户的长期隧道分开。连接命令成功后仍检查实际状态接口；它不是网络与远端服务永久可用的保证。
