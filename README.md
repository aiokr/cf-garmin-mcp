# cf-garmin-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aiokr/cf-garmin-mcp)

独立、单用户、自托管的 Garmin 运动健康平台，提供 Vue 仪表盘和只读 Remote MCP。MIT 开源代码，与 TrIndex 等应用完全解耦。

**当前版本：`1.0.0-dev.0`。** 已实现 V1.0 核心代码并完成本地 Workers 集成验证；真实 Garmin 四种认证组合、ChatGPT/Claude/OpenCode 实际客户端和独立 Cloudflare 账户部署按约定稍后验收。当前仓库为私有仓库，官方 Deploy 按钮要求公开源仓库，现阶段请使用 CLI；不会自动公开仓库。

## 功能

- Better Auth + D1：一次性部署密钥初始化唯一 Owner，邮箱密码登录、退出、改密、部署者 CLI 恢复；公开注册永久禁用。
- Garmin：Personal API / 环境变量账号密码两种模式，CN/GLOBAL 路由，Mobile SSO → DI OAuth2、MFA、加密 token、每连接 DO 串行续期和解绑。
- 数据：活动、每日健康、睡眠、训练指标、设备、纪录；D1 幂等摘要、私有 R2 FIT、CRC/SHA-256 校验、按需曲线/分段/轨迹。
- 同步：Cron + Workflows，最近 7 天优先、历史补录、重叠窗口、分流游标、限流退避、失败任务重试及归档修复。
- Dashboard：Overview、活动筛选/详情、健康/训练图表、OSM 轨迹、设置及任务状态；Base UI Vue、Lucide、Tripper Press 品牌明暗主题。无数据时保留空值。
- MCP：Streamable HTTP、OAuth discovery、动态客户端注册、S256 PKCE、资源与 scope 校验；独立授权清单、最近访问、即时撤销。
- 运维：根目录单 Worker 部署、官方迁移生成、CI、备份/空目标恢复、默认关闭日志遥测。

功能证据和未验收项见 [验收记录](docs/implementation.md)。

## 本地运行

需要 Node.js **24.12+**、pnpm **10.33.0**。

```sh
pnpm install --frozen-lockfile
pnpm secrets:local
pnpm db:migrate:local
pnpm dev
```

打开 `http://localhost:8787`。在本机查看 `.dev.vars` 的 `BOOTSTRAP_SECRET`，完成首次创建并登录。脚本生成独立随机密钥、设置文件权限 0600，不会覆盖已有配置或输出密钥。不要提交或在聊天中发送 `.dev.vars`。

Garmin 配置在根 `wrangler.jsonc` 选择 `GARMIN_AUTH_MODE=personal_api|credentials`、`GARMIN_REGION=CN|GLOBAL`。在 `.dev.vars` 只填写相应模式的 Secret：

```dotenv
# personal_api 模式
GARMIN_PERSONAL_API_KEY=
# credentials 模式（与上面的 Key 互斥）
GARMIN_EMAIL=
GARMIN_PASSWORD=
```

重启 Worker 后在设置页连接 Garmin；MFA 仅在当前会话提交。密码保留原始字符串，不裁剪或转码。Garmin 原始密码/API Key 不写入 D1、R2、浏览器或日志。

`pnpm dev` 构建 Vue 后由 Wrangler 同域提供应用；前端修改后运行 `pnpm build:web` 并刷新。认证写请求必须来自规范 origin，不要用另一个端口测试登录。

```sh
pnpm check                 # lint、Web/Worker/测试类型检查、完整构建、Workers 测试
pnpm build                 # Vue + Worker dry-run，不上传、不部署
node scripts/generate-auth-schema.mjs --check
```

## 连接 AI 客户端

在支持远程 MCP 的客户端添加 `https://你的域名/mcp`，按 OAuth 登录并选择权限。应用名称是客户端自报信息；授权页同时显示 client ID 和回调目的地。

| Scope             | 数据                        |
| ----------------- | --------------------------- |
| `profile:read`    | 基本资料                    |
| `activities:read` | 活动摘要、分段、统计、纪录  |
| `health:read`     | 步数、心率、HRV 等日常健康  |
| `sleep:read`      | 睡眠时长和评分              |
| `training:read`   | VO₂ Max、准备度、负荷       |
| `location:read`   | 与活动权限共同读取 GPS 轨迹 |
| `offline_access`  | 允许受控刷新授权            |

没有位置权限时，活动名称替换为运动类型，避免地点型标题泄露位置；没有健康权限时裁剪心率和热量。FIT 原始文件当前仅通过 Web Owner 会话下载，`files:read` 为保留 scope，没有 MCP 文件工具。MCP 不触发同步，不写 Garmin，也不内置 AI 聊天。

撤销某应用会原子清除它的 access/refresh token、consent 和未消费授权码；不影响其他应用、Web 会话或 Garmin 连接。每次 MCP 请求读取 D1 权威状态，不使用离线 JWT 撤销缓存。已读取的数据无法收回。

## 部署与维护

阅读 [自托管文档](docs/self-hosting.md)、[安全与恢复](docs/security.md)、[架构](docs/architecture.md)。需要独立 Cloudflare 账户资源及相应额度，不承诺完全免费。

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create cf-garmin-mcp
pnpm exec wrangler r2 bucket create cf-garmin-mcp-fit
# 修改根 wrangler.jsonc：真实 D1 UUID、HTTPS APP_URL、区域、时区
# 通过 wrangler secret put 设置所需 Secret
pnpm build
pnpm deploy
```

部署脚本验证配置、先迁移 DB binding，再发布 Worker。不能保留全零 D1 UUID 或 localhost APP_URL。生产初始化后删除 BOOTSTRAP_SECRET；D1 仍永久关闭重复初始化。

```sh
pnpm backup --local --output .wrangler/backups/manual
pnpm restore --local --persist-to .wrangler/restore-test --from .wrangler/backups/manual
```

备份包括一致的 D1 快照及其中引用的 FIT，逐文件校验散列；恢复仅允许空数据库，并清除旧会话和 OAuth token。独立备份 provider 加密密钥。远程操作必须显式传入 `--remote`，详见文档。

## 目录

```text
apps/web/                 Vue + Vite + Base UI Vue + Lucide + ECharts + MapLibre
apps/worker/src/          Hono / Better Auth / Garmin / DO / Workflows / MCP
apps/worker/migrations/   认证、业务、约束与维护表
packages/shared/         Zod 与 API 类型
scripts/                 Secret、迁移、部署校验、恢复、备份
tests/                  合成数据和 Workers 集成测试（无真实凭据）
 docs/                   架构、部署、安全与验收
wrangler.jsonc           唯一部署入口及 D1/R2/DO/Workflow/Cron/Assets 绑定
```

## License

[MIT](LICENSE)。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不隶属于 Garmin；使用者应遵守 Garmin 的适用条款。无验证码绕过、TLS 指纹模拟或跨认证模式自动切换。
