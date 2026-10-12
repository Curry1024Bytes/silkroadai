# 新服务器 new-api 后台白屏：SSH 取证与修复（2026-10-12）

新服务器 `103.240.199.146` 的状态接口与首页 HTML 正常，但原 SSH 隧道的大 JavaScript 传输
明显退化。保留旧 master，在独立新 TCP 上验证 BBR 后，已完成正式 `127.0.0.1:3000` 隧道迁移。
两项大 JS 完整下载，解压后的 SHA-256 与服务器一致；真实内置浏览器的首页和登录页完整渲染、
console error 数组为空。未提交登录，也未执行收费调用；本轮验收是连接、资源与页面加载。

这是宿主机网络维护。没有重启业务；new-api 继续只监听 `172.17.0.1:3000`，没有扩大公网暴露。
日常连接与安全切换方式以 [部署与运维手册 0.9](../deploy/部署与运维手册.md#09-ssh-隧道访问-new-api-后台)
为准。旧服务器的取证保留在 [2026-09-11 报告](SSH-TUNNEL-REPAIR-2026-09-11.md)，不能直接套用其
测速、IP 和别名作为新服务器事实。

## 故障与对照证据

- 原隧道的 `/api/status` 和首页 HTML 可以返回 HTTP 200；小响应正常不足以证明首页主 JS 完整加载。
- 本地 custom 源码的 Web 路由已经为静态资源启用 gzip。普通 curl 不发送 `Accept-Encoding`，
  未压缩 JS 的测速不能直接代表浏览器，因此本轮使用 gzip 响应验证实际传输。
- 原实际 SSH TCP 使用 CUBIC，累计重传字节约占已发送字节 16%。这是累计字节比例，不是精确线路
  丢包率；取证支持链路传输与拥塞控制是本次的瓶颈，不能仅因 SSH 握手或状态接口成功排除网络问题。

| 验证路径                      | 主 JS 传输结果                | 耗时          |
| ----------------------------- | ----------------------------- | ------------- |
| 服务器本地，gzip              | 本地资源响应正常              | 约 0.206 秒   |
| 原 CUBIC SSH 隧道，gzip       | 仅收到 1,069,099 字节，未完成 | 35 秒测试超时 |
| 独立新 TCP、BBR，gzip         | 完整传输 1,315,207 字节       | 12.166 秒     |
| 正式 3000、BBR，gzip 主包     | 完整传输 1,315,207 字节       | 1.992642 秒   |
| 正式 3000、BBR，gzip 另一大包 | 完整传输 1,217,902 字节       | 1.991454 秒   |

传输字节为压缩响应的下载字节数。CUBIC 那一项是未完成下载，不应把其局部大小解释为完整资源大小。
这里的结果是当次实测，不保证所有后续页面资源或所有时段都达到相同吞吐；请求延迟和线路波动仍可能存在。

真实内置浏览器通过独立测试隧道打开 `http://127.0.0.1:3001/`，已成功渲染 new-api 首页。
随后在正式 3000 并行下载当时首页引用的 `index.97d139bc37.js` 和 `4181.8f073f51b6.js`：
解压后大小分别为 4,579,755 与 6,099,995 字节，两项 SHA-256 与服务器本地逐项一致。
因此正式端口的两项资源验证包含完整性，不能只根据容器日志的 HTTP 200 判断已完整传输。

## 变更与影响范围

先保留原 master，再建立独立 TCP 隧道做对照；通过实际 TCP 连接验证新连接使用 BBR。默认算法变化
不会自动迁移旧 TCP，给旧 master 增加 `Compression=yes` 也不会重新协商压缩。

服务器只定向加载和设置 BBR。保留 `fq_codel` 与活动网卡的全部 qdisc，没有执行全局
`sysctl --system`，也没有因本次调整重启业务。持久配置为普通文件：

```text
# /etc/modules-load.d/llmroute-bbr.conf
tcp_bbr

# /etc/sysctl.d/99-llmroute-bbr.conf
net.ipv4.tcp_congestion_control = bbr
```

原网络状态备份保存在 `/opt/backups/llmroute-network/20261012-171749/`，包含：

- `before.json`、`ssh-before.txt`：变更前状态与 SSH 证据。
- `sysctl-merged-after.txt`：变更后合并配置检查。
- `after.json`：0600，变更后状态及业务基线核对。
- `final-verification.json`：0600，正式端口验收与清理后的最终记录。
- `restore-network.py`：0700，`py_compile` 语法检查通过，尚未执行。

本次没有重启服务器，因此没有完成整机重启后的模块、默认算法或隧道验收；持久文件存在不能代替
重启后的实际检查。

Mac 已备份并更新正式 SSH 配置，备份为
`/Users/elon/.ssh/config.bak.llmroute-20261012-172609`。正式配置为：

```sshconfig
Host llmroute-prod
    HostName 103.240.199.146
    User root
    IdentityFile ~/.ssh/llmroute_ed25519
    IdentitiesOnly yes
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.ssh/llmroute-prod.sock
    Compression yes
    LocalForward 127.0.0.1:3000 172.17.0.1:3000
    LocalForward 127.0.0.1:3306 127.0.0.1:3306
    LocalForward 127.0.0.1:5432 127.0.0.1:5432
    ExitOnForwardFailure yes
    ServerAliveInterval 15
    ServerAliveCountMax 4
```

远端 3306 没有服务，只保留迁移前遗留转发，不能称 MySQL 链路已验收。5432 对应 Portal PostgreSQL，
无鉴权 PostgreSQL SSLRequest 返回 `N`，证明隧道实际到达 PostgreSQL；这不是数据库登录验收。
new-api PostgreSQL 不发布宿主机端口，不能通过这两项转发连接。已 gzip 的静态 JS 再做 SSH 压缩
通常收益有限，本次不能将页面恢复的全部效果归因于 SSH 压缩。

## 保留旧连接并切换正式端口

1. 保留旧 master，确认测试端口空闲。使用 `-F /dev/null`、`-S none`、显式私钥与严格主机校验，
   建立独立前台 3001 隧道，避免继承正式别名的 3000/3306/5432 转发。不要加
   `ClearAllForwardings=yes`，它会连显式 `-L` 一起删除。
2. 在独立连接上验证状态 JSON、gzip 主 JS 完整下载、其他大资源以及真实浏览器渲染。服务器按
   客户端实际源端口关联 `ss -tinp`，核实该 TCP 的 BBR；仅检查全局 sysctl 不足够。
3. 记录旧 master 的实际 socket，用一个尚未使用的显式新 socket，先建立无转发的正式 master 并完成
   认证，再通过该 socket 执行远端命令验证可用。本次新 socket 为 `~/.ssh/llmroute-prod.sock`。
   保留旧 master 和测试 3001，不能先退出旧 master 再等待新连接握手。
4. 通过明确的旧 socket 执行 `-O cancel`，只取消原 3000/3306/5432 forward。确认监听释放后，给已经
   认证的新 master 添加三个回环 forward；使用 `-F /dev/null` 与显式 `-L` 避免继承其他转发。
   添加失败时先恢复旧 master 的监听，再排查。
5. 备份并更新 Mac 别名，验证正式 3000 的状态、实际 TCP 算法、大资源完整性和浏览器页面，核对三个
   监听归属。全部通过后才通过各自 socket 正常退出旧 master 和测试隧道，保留用户独立 shell。
   不删除 socket 文件来关闭进程，也不以修改后的别名猜旧 socket 路径。

日常使用先请求 `/api/status`，确认 new-api JSON 的 `success:true` 后直接复用已有连接；异常时才
补转发或新建连接，操作后再次验证。对已有监听重复 `ssh -O forward` 会报端口占用，部分缺失时先
定位监听归属，只添加缺失项。状态接口成功后仍不能省略首次或修复后的页面资源验收。

## 验收结果与边界

- 已验证：服务器本地 gzip 资源正常、独立新 TCP 使用 BBR、BBR gzip 主 JS 完整下载、真实内置浏览器
  通过测试 3001 成功渲染首页。
- 正式 3000 的 `/api/status` 返回 `success:true`、`setup:true`，服务器 `ss` 确认实际 SSH TCP 使用 BBR。
  上述两项大资源完整下载且解压后哈希一致。真实内置浏览器打开首页及 `/sign-in` 均完整渲染，
  console error 数组为空；没有提交登录。截图保存在 Mac `/tmp/llmroute-newapi-login-20261012.png`。
- `after.json` 与 `before.json` 核对：5 个业务容器的 ID、镜像、启动时间、重启次数保持一致，
  两份 `.env` 哈希与活动 qdisc 保持一致。容器均 running，new-api 与两个 PostgreSQL healthy，
  restart count 均为 0。
- 公网复查：`https://llmroute.club/login` 返回 200；`https://api.llmroute.club/v1/models` 假 Key 返回 401。
- 旧 master 与测试 3001 已通过明确 socket 正常退出，用户独立 shell 未动。清理后正式 3000 状态
  仍正常，新 master 持有三个回环监听；5432 已通过 PostgreSQL 协议探测，3306 仍无远端服务。
- 未执行：整机重启后验收、真实管理员登录流程、收费模型调用与支付。new-api 渠道/模型为空的业务
  准备边界仍以手册 0.14/0.15 为准，网络修复不会创建渠道或模型。

## 回退与后续复查

如有必要回退，先核对上述备份目录中的原状态、当前配置与恢复脚本。恢复入口是
`python3 /opt/backups/llmroute-network/20261012-171749/restore-network.py`；该脚本目前只完成语法检查，
没有实际执行。本次记录不代表回退演练已完成。恢复应定向回到原 CUBIC 及持久配置，不执行全局
sysctl 重载。算法回退同样只影响新 TCP，必须在保留可用连接的前提下新建隧道复验。
不要强制卸载仍可能被连接使用的 `tcp_bbr` 模块。

后续出现退化时，重新比较服务器本地与隧道 gzip 下载，记录实际 TCP 算法和重传字节指标。
BBR 是本次已验证的缓解措施，不能把它视为线路永久稳定的保证。
