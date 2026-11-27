# cf-garmin-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aiokr/cf-garmin-mcp)

独立、单用户、自托管的 Garmin 运动健康平台，提供 Vue 仪表盘和 Remote MCP。

## 功能

- Better Auth + D1：首次访问以邮箱密码创建唯一 Owner，无需初始化密钥；支持登录、退出、改密、部署者 CLI 恢复。初始化完成后永久关闭创建入口及公开注册。
- Garmin：Personal API / 环境变量账号密码两种模式，CN/GLOBAL 路由，Mobile SSO → DI OAuth2、MFA、加密 token、每连接 DO 串行续期和解绑。
- 数据：活动、每日健康、睡眠、训练指标、设备、纪录；D1 幂等摘要、私有 R2 FIT、CRC/SHA-256 校验、按需曲线/分段/轨迹。
- 同步：Cron + Workflows，最近 7 天优先、历史补录、重叠窗口、分流游标、限流退避、失败任务重试及归档修复。
- Dashboard：Overview、活动筛选/详情、健康/训练图表、OSM 轨迹、设置及任务状态；Base UI Vue、Lucide、Tripper Press 品牌明暗主题。无数据时保留空值。
- MCP：Streamable HTTP、OAuth discovery、动态客户端注册、S256 PKCE、资源与 scope 校验；独立授权清单、最近访问、即时撤销。
- 运维：根目录单 Worker 部署、官方迁移生成、CI、备份/空目标恢复、默认关闭日志遥测。

功能证据和未验收项见 [验收记录](docs/implementation.md)。

## 一键部署

点击顶部的 [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/aiokr/cf-garmin-mcp)，在浏览器中完成配置即可，无需安装本地开发工具。按钮会复制公开源仓库、创建资源、构建并发布；本项目会在迁移前确认 D1/R2 已就绪，补建缺失资源并自动写入 D1 UUID。完整云端流程仍待独立账户验收。

### 1. 准备账户与权限

- 准备 GitHub 和 Cloudflare 账户。官方按钮要求源仓库公开；私有仓库可通过 Cloudflare Workers Builds 连接自己的仓库，使用相同的构建/部署命令。
- 在 Cloudflare 控制台启用 R2，完成账户要求的开通步骤。自动建 Bucket 不能代替开通 R2。
- 配置账户的 `workers.dev` 子域名，或准备已绑定到此 Worker 的 HTTPS 自定义域名。
- 确认部署 API Token 对目标账户有 **D1 Write、Workers R2 Storage Write、Workers Scripts Write** 权限（控制台通常显示为相应的「编辑」权限）。默认构建 Token 未必包含 D1 权限，可在「My Profile → API Tokens」补齐或选择有权限的用户 Token，见[构建 Token 说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)。

### 2. 填写 D1、R2 和运行配置

选择目标账户、复制后的仓库名称和 Worker 名称。使用项目**根目录**作为构建目录，确认构建命令为 `pnpm build`、部署命令为 `pnpm run deploy`；不要使用跳过迁移的裸 `wrangler deploy`。

在部署配置页为当前实例创建或选择独立资源，保留绑定名：

| 绑定         | 需要配置的内容                                    | 部署脚本的处理                                                                         |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DB`         | 实例专用 D1 数据库名称，默认 `cf-garmin-mcp`      | 使用平台已分配的 UUID；尚未分配时按准确名称查找或创建，写入 UUID，再执行全部待应用迁移 |
| `FIT_BUCKET` | 实例专用 R2 Bucket 名称，默认 `cf-garmin-mcp-fit` | 检查已有 Bucket，不存在则创建；确认 r2.dev 和公共自定义域名均未开启                    |

同一账户部署多个实例时，为每个实例选择不同的 D1、R2 和 Workflow 名称。复用资源表示继续使用其中已有数据；脚本不会清库或删除对象。明确配置的 D1 UUID 不可用时会停止，不会替换成新的空数据库。

部署页保留 `APP_URL` 和 `PROVIDER_KEY_VERSION`，普通部署无需修改它们的默认值。`APP_URL`、`GARMIN_AUTH_MODE`、`GARMIN_REGION` 也可在「Settings → Build → Build variables and secrets」设置同名变量，脚本会将它们写入此次部署配置：

| 名称               | 值                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`          | 保留 `http://localhost:8787` 默认值时，自动生成 `https://Worker名称.账户子域名.workers.dev`；自定义域名则填写实际 HTTPS origin，无子路径 |
| `PROVIDER_KEY_VERSION` | 保持默认 `1`；这是 Garmin token 加密密钥版本号，仅按密钥轮换流程才递增，不是 Garmin API 或应用版本 |
| `GARMIN_AUTH_MODE` | 默认 `credentials`，或改为 `personal_api`                                                                                                |
| `GARMIN_REGION`    | 默认 `CN`，国际区账户改为 `GLOBAL`                                                                                                       |

日期统计与展示的时区固定为内置 `Asia/Shanghai`，活动轨迹使用内置 OSM 默认底图 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`；Cloudflare 部署页无需填写 `APP_TIMEZONE` 或 `OSM_TILE_URL`，也不通过环境变量覆盖它们。

资源准备使用部署环境中的 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。如构建环境未提供，在 Build variables and secrets 中补充目标账户 ID 和有上述权限的 Token；Token 作为**构建 Secret**保存，不要填进应用普通 vars。它们用于部署，不会作为运行时变量传入 Worker。

### 3. 填写 Garmin 凭据（模式二选一）

Cloudflare 模板从 `.dev.vars.example` 读取 Garmin Secret 提示。按 `GARMIN_AUTH_MODE` **只填写其中一组**；如果在控制台补充，使用 Worker 的「Variables & Secrets」，不要混入上一节的构建变量。

| 模式                  | 需要填写的 Secret                                       |
| --------------------- | ------------------------------------------------------- |
| `credentials`（默认） | `GARMIN_EMAIL` + `GARMIN_PASSWORD`，Garmin 原始账号密码 |
| `personal_api`        | `GARMIN_PERSONAL_API_KEY`，其他 Garmin 凭据留空         |

内部 `BETTER_AUTH_SECRET`（应用认证）和 `PROVIDER_ENCRYPTION_KEY`（Garmin token 加密）由 Cloudflare 部署脚本使用安全随机数自动生成，作为 Worker Secret 持久保存，不要求在模板中输入。后续部署保留已有值，不会每次构建重新生成或自动轮换；请勿删除它们。同一 Worker 的部署应串行执行，避免同时首次生成密钥。加密密钥应单独安全备份，丢失后已有 token 密文无法恢复。Secret 不写入普通 vars、Git、浏览器或构建日志。

### 4. 部署并初始化

云端流程包括：**安装依赖及构建 → 准备 D1/R2 和正式 APP_URL → 验证配置、准备并保留内部 Secret → 对远程 DB 应用迁移并发布 Worker**。平台已创建资源时直接确认和复用，后续重建也使用相同资源。准备、权限检查或迁移失败会停止发布；修正控制台配置后重试。

部署日志出现 `Deployment resources ready. APP_URL=...` 时可确认最终地址。首次打开该地址，设置名字、邮箱和至少 12 个字符的密码创建唯一 Owner，**无需 bootstrap key 或其他初始化密钥**。登录后仍需在设置页连接 Garmin、完成 MFA（如有）并同步，再配置下方的 MCP 客户端。自定义域名需要另外完成 Worker 域名绑定，自动准备不会管理 DNS。

**首访抢占风险：未初始化实例没有部署者身份校验，任何能访问创建页面的人都可能先创建 Owner。** 部署完成后立即初始化，在此之前不要分享 URL；需要更强保证时，在外围限制访问并覆盖 workers.dev、自定义域名等全部入口。Origin 校验和限流不能消除抢占风险。Owner 创建成功后，永久初始化标志和单用户约束会关闭后续创建，恢复走部署者维护流程。

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

此命令在根目录生成 `.dev.vars`，包含两个独立随机值：`BETTER_AUTH_SECRET`（应用认证）、`PROVIDER_ENCRYPTION_KEY`（Garmin token 加密）；首次创建 Owner 不需要初始化密钥。脚本请求设置文件权限 0600，不输出密钥；Windows 上还需依靠文件 ACL 控制访问。若文件已存在，脚本会拒绝覆盖，请直接编辑现有文件；不要复制空模板覆盖已生成的值，也不要提交或在聊天中发送 `.dev.vars`。

编辑根目录 `wrangler.jsonc` 的 `vars`：

| 配置项             | 本地配置                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `APP_URL`          | 保持 `http://localhost:8787`，必须与浏览器访问地址一致                   |
| `GARMIN_AUTH_MODE` | 二选一：`credentials`（当前默认）或 `personal_api`                       |
| `GARMIN_REGION`    | 按 Garmin 账户所属区域选择 `CN`（中国区，当前默认）或 `GLOBAL`（国际区） |

本地也使用内置固定时区 `Asia/Shanghai` 和 OSM 默认底图，无需配置时区或瓦片地址；`PROVIDER_KEY_VERSION` 保持默认 `1`，仅密钥轮换时才修改。

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
2. 设置名字、登录邮箱和至少 12 个字符的密码，无需初始化密钥。此账户是本应用唯一 Owner，与 Garmin 登录凭据独立；任何能访问未初始化实例的人均可抢先创建，尤其不要在初始化前将本地服务暴露到公网。
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

本节介绍 **CLI 手动部署**，与按钮的云端部署是两条路径。手动部署也无需先生成本地 `.dev.vars`、初始化本地数据库或启动 `pnpm dev`；直接完成以下生产配置即可。

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
| `vars.APP_URL` | 保留默认 `http://localhost:8787`，prepare 自动生成正式 workers.dev 地址；仅自定义域名时改为实际 HTTPS origin，无子路径 |
| `vars.PROVIDER_KEY_VERSION` | 保留默认 `1`，仅轮换 Garmin token 加密密钥时按维护流程递增 |
| `vars.GARMIN_AUTH_MODE` / `vars.GARMIN_REGION` | 与所选凭据、Garmin 账户区域一致                                                                        |

默认配置已启用 `workers_dev`，可直接使用上述 Worker 名称与账户子域名组成的地址；若使用自定义域名，还需在 Cloudflare 配置对应 Worker 的域名绑定，并将 `APP_URL` 设为该地址。资源名称冲突时使用新名称，并同步更新配置；不要更改代码依赖的 `DB`、`FIT_BUCKET` 等 binding 名。

### 3. 配置部署凭据和 Garmin Secret

内部 `BETTER_AUTH_SECRET` 和 `PROVIDER_ENCRYPTION_KEY` 由 Cloudflare 部署脚本按缺失创建并作为 Worker Secret 持久保存，后续部署复用已有值；不需要手动生成或上传，也不需要 `BOOTSTRAP_SECRET`。准备好目标账户的 `CLOUDFLARE_ACCOUNT_ID` 和具有上述权限的 `CLOUDFLARE_API_TOKEN`，供脚本调用 Cloudflare API；不要将部署 Token 写入普通 vars 或提交到 Git。`.dev.vars` 只供本地使用，不会随部署自动上传。

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
pnpm run deploy
```

`validate:deploy` 检查生产 URL、D1 UUID、R2 名称和 Garmin 模式/区域；日期口径固定为内置 `Asia/Shanghai`，地图使用内置 OSM 默认底图，无需配置时区或瓦片地址；它不验证远程 Secret 是否齐全。`build` 构建 Vue 并执行 Worker dry-run，不上传。`pnpm run deploy` 负责准备并持久保存内部 Secret；Workers Builds 与本地 CLI 均会先自动准备或复用 D1/R2 资源，再验证配置、对远程 **DB binding** 应用迁移并发布 Worker。设置好 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN` 后，本地也可先执行 `pnpm deploy:prepare` 自动准备 D1/R2。无需另外手动执行远程迁移。当前独立 Cloudflare 账户部署和 Workflows 实际创建仍待验收，状态见[验收记录](docs/implementation.md)。

### 5. 初始化并验证线上实例

部署完成后立即打开 `APP_URL`，以名字、邮箱和至少 12 个字符的密码创建唯一 Owner，无需初始化密钥。初始化前不要分享地址，任何可访问者都可能抢占；必要时对全部入口加外围访问限制。重新登录后在设置页连接 Garmin、完成 MFA（如有）并发起同步。确认登录、退出和同步记录正常，再按上方「连接 AI 客户端」配置 `APP_URL` + `/mcp` 并验证所授权的数据可读。

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
