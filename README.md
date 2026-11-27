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

## 从零开始：本地运行

完整流程为：准备工具 → 获取源码 → 配置密钥和 Garmin → 初始化本地数据库 → 创建 Owner → 连接并同步。只做本地开发时无需创建远程 Cloudflare 资源；需要公网访问和远程 MCP 时，继续下方「从零开始：部署到 Cloudflare」。获取源码并进入项目目录后，其余命令均在项目根目录执行，适用于 PowerShell 和常见 Unix shell。

### 1. 准备工具并获取源码

先安装 Git 和 Node.js **24.12+**（包含 npm），再安装本项目锁定版本的 pnpm：

```sh
npm install --global pnpm@10.33.0
git --version
node --version
pnpm --version

git clone https://github.com/aiokr/cf-garmin-mcp.git
cd cf-garmin-mcp
pnpm install --frozen-lockfile
```

确认 Node.js 版本不低于 `24.12.0`、pnpm 为 `10.33.0`。当前仓库为私有，克隆前需让 Git 使用有仓库访问权限的 GitHub 账户；如果已经获取源码，直接进入项目目录安装依赖即可。Wrangler 随项目依赖安装，后续用 `pnpm exec wrangler` 调用，无需全局安装。

### 2. 生成本地密钥并配置 Garmin

```sh
pnpm secrets:local
```

此命令在根目录生成 `.dev.vars`，包含三个独立随机值：`BETTER_AUTH_SECRET`（应用认证）、`BOOTSTRAP_SECRET`（首次创建 Owner）、`PROVIDER_ENCRYPTION_KEY`（Garmin token 加密）。脚本请求设置文件权限 0600，不输出密钥；Windows 上还需依靠文件 ACL 控制访问。若文件已存在，脚本会拒绝覆盖，请直接编辑现有文件；不要复制空模板覆盖已生成的值，也不要提交或在聊天中发送 `.dev.vars`。

编辑根目录 `wrangler.jsonc` 的 `vars`：

| 配置项             | 本地配置                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `APP_URL`          | 保持 `http://localhost:8787`，必须与浏览器访问地址一致                   |
| `APP_TIMEZONE`     | 日期统计和展示使用的 IANA 时区，例如 `Asia/Shanghai`                     |
| `GARMIN_AUTH_MODE` | 二选一：`credentials`（当前默认）或 `personal_api`                       |
| `GARMIN_REGION`    | 按 Garmin 账户所属区域选择 `CN`（中国区，当前默认）或 `GLOBAL`（国际区） |

然后在 `.dev.vars` 中追加所选模式的凭据。使用 `credentials` 时填写 Garmin 账号密码：

```dotenv
GARMIN_EMAIL=你的Garmin登录邮箱
GARMIN_PASSWORD=你的Garmin原始密码
```

使用 `personal_api` 时改填已有的 Garmin Personal API Key：

```dotenv
GARMIN_PERSONAL_API_KEY=你的GarminPersonalAPIKey
```

两种模式互斥，只填写其中一组；Personal API Key 需要自行准备，与本项目的 MCP PAT Key 无关。不填写 Garmin 凭据也可先初始化并登录 Web，连接和同步需配置正确凭据。密码保留原始字符串，不裁剪或转码；原始密码/API Key 不写入 D1、R2、浏览器或日志。

### 3. 初始化本地数据库并启动

```sh
pnpm db:migrate:local
pnpm dev
```

本地开发使用 Wrangler 模拟的 D1、R2 等资源，状态保存在 `.wrangler/state`；无需将配置中的全零 D1 UUID 替换为远程 UUID。迁移命令执行项目已有的建表迁移，不需要手动创建表。

`pnpm dev` 先构建 Vue，再由 Wrangler 在 `http://localhost:8787` 同域提供页面和 API。保持终端运行；修改 `.dev.vars` 或 Wrangler 配置后重启此命令。前端修改后运行 `pnpm build:web` 并刷新。认证写请求必须来自规范 origin，访问时使用 `localhost:8787`，不要换成 `127.0.0.1` 或其他端口。

### 4. 创建 Owner 并完成首次同步

1. 打开 [本地应用](http://localhost:8787)，首次进入会显示「创建你的空间」。
2. 在本机编辑器中查看 `.dev.vars` 的 `BOOTSTRAP_SECRET`，将它填入「一次性初始化密钥」，并设置名字、登录邮箱和至少 12 个字符的密码。此账户是本应用唯一 Owner，与 Garmin 登录凭据独立。
3. 创建后使用刚设置的邮箱和密码登录。进入「设置 → Garmin 连接」连接账号；若提示 MFA，在页面提交本次验证码。
4. 在设置页发起同步，查看「同步记录」中的状态，再到总览和运动记录页检查数据。先验证最近数据，再按需补录历史；Personal API 模式不支持训练同步，相关指标可能为空，详见[同步与存储](docs/self-hosting.md#同步与存储)。

本地和生产使用独立数据库与密钥，部署后需要重新创建 Owner、连接 Garmin；上述步骤不会自动上传本地数据。

### 5. 开发检查

```sh
pnpm check                 # lint、Web/Worker/测试类型检查、完整构建、Workers 测试
pnpm build                 # Vue + Worker dry-run，不上传、不部署
node scripts/generate-auth-schema.mjs --check
```

## 连接 AI 客户端

在支持远程 MCP 的客户端添加 `https://你的域名/mcp`，按 OAuth 登录并选择权限。应用名称是客户端自报信息；授权页同时显示 client ID 和回调目的地。也可在 Web 的「MCP 服务 → PAT Key」创建个人访问密钥，在客户端的 PAT_key / Bearer Token 配置中填写（请求头 `Authorization: Bearer <PAT_key>`）。密钥仅显示一次，可选择权限和有效期、随时撤销；与 OAuth 共用连接地址。

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

## 从零开始：部署到 Cloudflare

先完成上方工具安装、获取源码和 `pnpm install --frozen-lockfile`。部署需要 Cloudflare 账户、可用的 Workers/D1/R2/Workflows 资源及相应额度；先在控制台启用 R2，并确认账户的 `workers.dev` 子域名。不承诺完全免费，完整维护说明见[自托管文档](docs/self-hosting.md)、[安全与恢复](docs/security.md)和[架构](docs/architecture.md)。

### 1. 登录并创建独立资源

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create cf-garmin-mcp
pnpm exec wrangler r2 bucket create cf-garmin-mcp-fit
```

按浏览器提示授权，使用 `whoami` 确认当前 Cloudflare 账户。保存创建 D1 时返回的 `database_id`。R2 Bucket 保持私有，不启用公共访问。

### 2. 填写生产配置

编辑根目录 `wrangler.jsonc`，保留现有绑定和迁移配置，仅按部署目标调整：

| 配置位置                                       | 要填写的值                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`                                         | Worker 名称，默认 `cf-garmin-mcp`                                                                      |
| `d1_databases[0].database_id`                  | 上一步返回的真实 D1 UUID，不能保留全零占位值                                                           |
| `d1_databases[0].database_name`                | 刚创建的数据库名称                                                                                     |
| `r2_buckets[0].bucket_name`                    | 刚创建的私有 Bucket 名称                                                                               |
| `vars.APP_URL`                                 | 实际 HTTPS origin，无子路径，例如 `https://cf-garmin-mcp.你的子域名.workers.dev`，不能直接复制占位地址 |
| `vars.APP_TIMEZONE`                            | 例如 `Asia/Shanghai`                                                                                   |
| `vars.GARMIN_AUTH_MODE` / `vars.GARMIN_REGION` | 与所选凭据、Garmin 账户区域一致                                                                        |

默认配置已启用 `workers_dev`，可直接使用上述 Worker 名称与账户子域名组成的地址；若使用自定义域名，还需在 Cloudflare 配置对应 Worker 的域名绑定，并将 `APP_URL` 设为该地址。资源名称冲突时使用新名称，并同步更新配置；不要更改代码依赖的 `DB`、`FIT_BUCKET` 等 binding 名。

### 3. 生成并上传生产密钥

生产 Secret 通过 Wrangler 单独上传，`.dev.vars` 仅供本地使用，不会随部署自动上传。为生产生成独立密钥：以下第一条命令分别运行两次，得到不同的 `BETTER_AUTH_SECRET` 和 `BOOTSTRAP_SECRET`；第二条生成 `PROVIDER_ENCRYPTION_KEY`。输出是敏感值，只在本机保存。

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

依次执行以下命令，在交互提示中粘贴对应值，不把密钥写进命令参数或 `wrangler.jsonc`。单独备份 `PROVIDER_ENCRYPTION_KEY`，恢复加密的 Garmin token 时需要它。

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put BOOTSTRAP_SECRET
pnpm exec wrangler secret put PROVIDER_ENCRYPTION_KEY
```

再按 `GARMIN_AUTH_MODE` 上传**一组** Garmin 凭据。`credentials` 模式：

```sh
pnpm exec wrangler secret put GARMIN_EMAIL
pnpm exec wrangler secret put GARMIN_PASSWORD
```

或 `personal_api` 模式：

```sh
pnpm exec wrangler secret put GARMIN_PERSONAL_API_KEY
```

如果以后切换模式，先用 `pnpm exec wrangler secret delete <旧Secret名称>` 删除旧模式的 Garmin 凭据，再上传新模式凭据，避免两组同时存在。

### 4. 构建、迁移并发布

```sh
pnpm validate:deploy
pnpm build
pnpm deploy
```

`validate:deploy` 检查生产 URL、D1 UUID、时区和 Garmin 模式/区域；它不验证远程 Secret 是否齐全。`build` 构建 Vue 并执行 Worker dry-run，不上传。`deploy` 再次验证配置，先对远程 **DB binding** 应用迁移，再发布 Worker；无需另外手动执行远程迁移。当前独立 Cloudflare 账户部署和 Workflows 实际创建仍待验收，状态见[验收记录](docs/implementation.md)。

### 5. 初始化并验证线上实例

打开 `APP_URL`，使用**生产** `BOOTSTRAP_SECRET` 创建唯一 Owner，重新登录后连接 Garmin、完成 MFA（如有）并发起同步。确认登录、退出和同步记录正常，再按上方「连接 AI 客户端」配置 `APP_URL` + `/mcp` 并验证所授权的数据可读。

完成初始化后删除生产一次性密钥：

```sh
pnpm exec wrangler secret delete BOOTSTRAP_SECRET
```

D1 初始化标志会永久阻止重复创建 Owner；后续账户恢复使用[安全与恢复](docs/security.md)中的维护流程。如果再回到本地开发，先将 `vars.APP_URL` 改回 `http://localhost:8787`。

## 备份与维护

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
