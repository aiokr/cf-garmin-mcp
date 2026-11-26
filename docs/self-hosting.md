# 自托管、备份与升级

当前为待真实联调的开发版；生产上线前完成 implementation.md 中的发布验收。根目录是唯一部署入口，不复用其他项目的身份、D1 或 Bucket。

## 本地

Node.js 24.12+，pnpm 10.33.0。运行 `pnpm install --frozen-lockfile` → `pnpm secrets:local` → `pnpm db:migrate:local` → `pnpm dev`。规范 origin 为 `http://localhost:8787`，其他端口/127.0.0.1 的写请求不接受。生产 HTTPS Cookie 启用 Secure/HttpOnly/SameSite=Lax；本地 HTTP 仅为开发关闭 Secure。

## 手动部署

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create cf-garmin-mcp
pnpm exec wrangler r2 bucket create cf-garmin-mcp-fit
```

修改根 wrangler.jsonc：填写返回的 D1 UUID，配置真实 HTTPS APP_URL（无子路径）、IANA 时区、Garmin 模式和区域。资源名称冲突时同时调整 Worker、Bucket 和 Workflow 名称。R2 保持私有，不启用 r2.dev 或公共域名。预览 URL 默认关闭；检查自定义域名和 workers.dev 两个入口。

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put BOOTSTRAP_SECRET
pnpm exec wrangler secret put PROVIDER_ENCRYPTION_KEY
# personal_api 模式：
pnpm exec wrangler secret put GARMIN_PERSONAL_API_KEY
# 或 credentials 模式：
# pnpm exec wrangler secret put GARMIN_EMAIL
# pnpm exec wrangler secret put GARMIN_PASSWORD
pnpm build
pnpm deploy
```

BETTER_AUTH_SECRET、BOOTSTRAP_SECRET 分别使用至少 32 个高熵随机字符；PROVIDER_ENCRYPTION_KEY 使用独立 32 字节 base64 值。只填写所选模式的 Garmin 凭据，两种模式不能共存。密码按原始字符串提供；不要写入普通 vars、Git、命令参数或日志。生产部署脚本拒绝全零 D1 UUID、localhost/占位 APP_URL 和错误模式/区域。

部署脚本先对 **DB binding** 应用迁移，再发布单 Worker。根配置包含 Static Assets、D1、R2、三类 DO、SyncWorkflow 和 Cron。Workflows 的实际创建及官方自动资源配置兼容性仍需在独立账户验证。

打开 APP_URL，以一次性密钥创建唯一 Owner。确认登录/退出可用后执行 `wrangler secret delete BOOTSTRAP_SECRET`。D1 初始化标志不可重新开启；恢复使用维护脚本。

## 同步与存储

设置页连接 Garmin，按提示完成 MFA；先同步最近 7 天，再按设置补录历史。健康默认 90 天（可选 1–365），活动默认 365 天（可选 1–7300）；更长健康历史可分窗实施，单次健康/训练查询及补录窗口最多 366 天。手动活动补录支持更长范围，分页预算最多 200000 条。不要把 API/设备不支持的指标当作真实零。

Cron UTC 时间表：活动/FIT 每 30 分钟，健康每小时第 5 分钟，训练每日 02:15，设备/归档维护每周日 02:30。Owner 时区用于日期口径和 Web 展示。可关闭自动同步及 FIT 归档；大文件默认 16 MiB，上限 32 MiB，超限保留错误状态。受设备与账号能力影响，私有接口可能失败；不要尝试规避验证码或风控。

文件以 SHA-256 不可变键保存。索引失败可重试或由周度扫描重建；缺失对象标记错误。历史数据和旧对象默认保留，不因上游暂时缺失自动删除。管理者自行决定外部保留/清理策略。

## MCP

客户端连接 APP_URL + `/mcp`。外部客户端通过 Bearer token 访问，不能读取 Garmin token。HTTP 应用写入仍检查 Origin；OAuth token/register/introspect/revoke 协议端点不依赖 Cookie。浏览器直接调用 MCP 时，可在 `MCP_ALLOWED_ORIGINS` 中配置精确的额外 Origin（逗号分隔），默认只允许应用自身 Origin；无 Origin 的服务端客户端不受该列表影响。

OAuth access token 15 分钟，refresh token 最长 30 天，仍受原授权会话、consent 和撤销状态约束。退出或过期的原会话会使相关授权不可用，客户端需重新登录授权。动态注册名称不表示真实身份；核对 client ID、回调地址和 scope。

## 密钥轮换

保留当前 key 备份。将旧 provider key 设置为 Secret `PROVIDER_ENCRYPTION_KEY_PREVIOUS`，更新 `PROVIDER_ENCRYPTION_KEY`，将 `PROVIDER_KEY_VERSION` 加一后部署。Owner 会话 POST `/api/v1/connections/:id/rotate`（携带正确 Origin）重新加密该连接 token；验证所有连接及备份可读后再删除 previous key。版本解析只支持当前和前一版本，不要跳级或过早丢弃旧 key。应用认证 Secret 与 provider 加密 key 独立；应用 Secret 轮换会要求重新验证 Garmin 配置指纹。

## 备份和恢复

```sh
pnpm backup --local --output .wrangler/backups/manual
pnpm restore --local --persist-to .wrangler/restore-test --from .wrangler/backups/manual
# 远程目标必须显式使用 --remote，先在独立账户与新资源演练。
```

备份脚本导出一致 D1 SQL 快照，从该快照解析 ready 文件索引、下载相应 FIT、验证大小及 SHA-256，生成受保护 manifest。目录 0700、文件 0600；包含账户散列、会话和健康数据，必须私有保存。Wrangler 的本地 D1 export 使用标准 `.wrangler/state`，备份不支持自定义 persist-to；恢复可以选择独立本地目录。

恢复验证 manifest/所有文件后，只允许空目标数据库，先恢复 R2，再导入 D1，并清除 Web session、OAuth token 和 verification，避免旧备份恢复旧访问权限。旧 consent 保留，客户端须重新认证。加密 key 单独恢复，绝不包含在备份文件中。导入中断时使用新的空目标重试；不要盲目覆盖部分恢复的数据。

本轮本地 CLI 验证了完整数据库的 0-FIT 备份恢复；合成 FIT 的内容、R2/D1 故障与修复由 Workers 测试验证。生产全量备份/恢复尚待真实验收。

## 发布、升级与回滚

当前 GitHub 仓库按用户要求保持私有、只推送 dev，不合并 main。官方 Deploy 按钮需要公开源仓库；用户决定公开后再在未预建资源的独立账户验收克隆、Secrets、APP_URL、资源绑定、迁移、构建、初始化、MCP 和真实同步。按钮存在不代表一键部署已成功。

升级前备份 D1/R2 和独立 key，恢复到隔离目标测试。认证迁移由 Better Auth 官方 getMigrations 生成；运行 `node scripts/generate-auth-schema.mjs --check` 检查漂移，新变更生成新迁移，禁止覆写已部署迁移。迁移必须向后兼容；Worker rollback 不会回滚数据库。数据回滚在维护状态下完成，验证后再开放流量。

Cloudflare 账户权限、免费/付费额度及使用条款以部署时官方文档为准；不承诺完全免费。首次大范围历史同步和 FIT 归档可能产生请求、CPU 和存储费用。
