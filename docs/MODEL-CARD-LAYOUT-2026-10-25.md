# 模型卡片与价格排版修复（2026-10-25）

用户反馈模型清单的卡片和价格文字排版异常。已在实际公网页面复现：同一行的
`claude-sonnet-5-5` 与 `gpt-5.6-sol` 价格起始位置相差 39px。

## 原因与修改

- 价格区使用 `margin-top:auto`，计费条件长短不同会把金额推到不同高度。现在让同排卡片的
  标题、简介、价格、元信息和页脚共享网格行；保留 Flex 回退，不用固定高度截断文字。
- 卡片列数以前按整个视窗宽度判断，工作台外层侧栏会让实际卡片空间不足。现在按模型列表
  的实际容器宽度选择一、二、三列。
- 价格摘要改用 Flex gap，避免段落 `m-0` 覆盖原有间距；保留完整金额、单位、分组和计费条件。
  单项价格使用整行，双列价格的标签和金额共享行高。
- 分组与端点各占一行，端点名称允许自然换行；窄卡片的性能数据和详情按钮允许换行，避免挤压。

修改只涉及展示组件与作用域样式，没有修改报价计算、数据接口、数据库、授权或计费逻辑。
vendored 前端的版权与许可证说明保留，未修改 new-api 后端。

## 验证

- 独立浏览器读取当前公开目录快照，在使用真实组件和项目 CSS 的本机预览中验证：
  1440px 视窗/1048px 列表为三列，1440px 视窗/728px 列表为两列，390px 与 320px 视窗为一列。
- 同排价格纵向偏差为 0px；页面无横向溢出，页脚按钮与数据无重叠或裁切。
- 长模型名、长分组名以及千 token 单位下 `¥0.000000000000001` 的完整精度显示通过。
- 完整非联机测试：388 files / 6258 passed / 1 skipped；typecheck 通过；lint 0 errors / 100 warnings。
- 本机生产 Next 构建通过，构建使用无效的本地占位连接，不连接生产数据库。
- 本机视觉与检查证据保存在被 Git 忽略的 `outputs/models-layout-20261025/`。

## 已上线

- 应用提交 `04f0bdf19d2e0b4f67cdd2a2761f9b8ab61196a1`。独立原生 amd64 构建
  `40186949650` 成功，应用与构建流程 CI 均通过；VPS 仅加载已校验镜像。
- 北京时间 19:57:00 开始切换，19:57:11 新镜像返回 200，首次失败至恢复的探测间隔为
  10.589 秒。Portal restart count 0，其余四个业务容器的 ID、镜像与启动时间保持。
- 运行标签 `silkroadai-portal-portal:release-04f0bdf1`；VPS manifest digest
  `sha256:6e2cea14a804a9aba934421f39a4d0f1b1e8e2c29cf929bc41649b2dab0b5c28`，配置 digest
  `sha256:2d8309f8e3df20064f00d770b90c90821eea7ea44a80f342d5d42cf7d1d89b98`。已核对配置和
  18 层摘要，以及镜像内实际生产 CSS/JS 包含本次布局实现。
- 线上独立浏览器实测 20 张卡片：价格区与首行金额在同排内的纵向偏差均为 0px，390px
  页面无横向溢出、无页面 JS 异常。金额及原计费条件保持完整显示。
- 没有新增 migration，88 条迁移及原有历史保持；生产环境文件、目录/报价/分组/用户/Key、
  计费选项与未决业务摘要均与发布前一致。未修改 Nginx、new-api 后端或实际价格，未进行收费调用。
- 备份目录 `/opt/backups/silkroadai-portal/releases/model-layout-20261025-113233/`；旧应用
  `release-5a0e613e` 与回退标签 `silkroadai-portal-portal:rollback-model-layout-20261025-113233`
  保留。回退应用不需要恢复数据库。
- 同名备份已复制到 operator Mac 的 `~/Backups/LLmRoute/portal/releases/`，SHA256、gzip 及
  目录 0700/含密文件 0600 权限均验证通过。
- 当前使用 `/opt/llmroute-releases/04f0bdf1/source/docker-compose.prod.yml` 和
  `/opt/llmroute-releases/04f0bdf1/release.json`，project directory 和 `.env` 仍在原项目目录。
- 发布前对先前停用的专用 BuildKit 容器进行取证，保存日志、完整配置和 4 个数据库元数据文件，
  再仅移除该临时构建器与其缓存；未清理其他构建器、业务卷或旧回退镜像。取证资料位于
  `upstream-final-20261025-073943/failed-builder-forensics/`。
- 本次产物改用压缩上传；因 Mac→VPS 的 SCP 链路过慢，最终由 VPS 通过临时签名链接从 GitHub
  直接下载，并再次验证原始镜像归档 SHA256。GitHub 账户 token 未传到服务器，未恢复生产机编译。
