# V1.0 实施与验收记录

2026-11-26，版本 `1.0.0-dev.0`。来源：[技术方案](https://app.notion.com/p/4246531e06a281798caec1f314073ec9)。用户已确认：本次完成代码、验证和私有仓库推送；真实联调稍后进行。图标全部改用 Lucide；产品界面移除部署/注册策略等赘述。

| 阶段 | 已实现/验证                                                                               | 保留的真实验收                                                      |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| M0   | Better Auth/D1、OAuth、Base UI、FIT 的本地 Workers 兼容验证；四种 Garmin 模式合成响应测试 | CN/GLOBAL × Personal API/账号密码真实登录、MFA、续期、指标覆盖、FIT |
| M1   | 根部署入口、workspace、Vue/Hono/Assets、迁移、原子初始化/登录/退出/改密、限速             | 独立 Cloudflare 账户安装                                            |
| M2   | 环境凭据、固定区域、Mobile SSO/DI/MFA、AES-GCM/AAD、DO 队列、凭据变更/解绑、密钥轮换      | 真实区服和账号身份边界                                              |
| M3   | 活动/健康/训练持久化、R2 FIT、增量/历史、Workflows/Cron、重试、游标、归档修复             | 长时间历史任务、真实大文件与平台额度                                |
| M4   | 总览、活动/详情、健康、训练、设置、ECharts、OSM、主题/移动布局、Lucide                    | 真实运动数据与地图、目标浏览器回归                                  |
| M5   | discovery、DCR、PKCE、授权页、scope/resource、只读工具、应用清单及即时撤销                | ChatGPT/Claude/OpenCode 至少两个实际客户端                          |
| M6   | MIT/第三方声明、CI、部署/恢复/升级文档、部署预检、备份/空目标恢复脚本                     | 新账户 Deploy 按钮、生产备份恢复、正式版本发布                      |

## 自动化证据

`pnpm check` 已通过 29 项集成测试，包括 ESLint、Vue/Worker/测试类型检查、生产前端构建、Worker dry-run 和 Workers 运行时测试。测试不使用真实 Garmin 凭据或真实健康/GPS 数据。

覆盖：匿名拒绝、Origin 校验、注册关闭、并发 bootstrap 唯一性、会话 Cookie、密码更新/旧会话失效、持久化限速；双模式/两区路由、MFA/CAPTCHA 停止、Retry-After、加密 AAD/轮换、并发续期一次、解绑拒绝；重复/迟到活动、字段缺失、FIT CRC/ZIP/单位/分段、R2 失败、D1 索引失败后孤儿恢复；真实 Workflow 防重和失败不推进游标；两个模拟 OAuth 客户端的完整注册/PKCE/consent/token/MCP、越权拒绝、错误 audience、过期和独立撤销。

认证表迁移 0001/0004 由锁定 Better Auth 官方 getMigrations API 生成；schema check 对全部已提交迁移检查漂移。

本地 D1 全量迁移、备份导出、空目标恢复已验证；本轮 CLI 备份包含 0 个 FIT。FIT/R2 内容验证和故障恢复由 Workers 测试中的合成文件覆盖，未声称远程全量恢复完成。

## 发布前清单

- [ ] 四个真实 Garmin 组合分别记录账号 profile、MFA、续期、字段与 FIT 结果，不能用 mock 替代。
- [ ] 至少两个实际 MCP 客户端独立授权；客户端 A 撤销后 B、Web 和真实同步持续可用。
- [ ] 全新 Cloudflare 账户验证 D1/R2/DO/Workflows/Secrets/APP_URL/迁移与所有入口。
- [ ] 检查 R2 公共访问关闭、日志不含秘密或健康数据、时区和历史范围正确。
- [ ] 生产备份恢复及加密密钥恢复，检查索引/对象与旧授权失效。
- [ ] 仓库保持私有直到用户另行决定；官方 Deploy 按钮仅在公开源仓库后验收，不自动公开。
- [ ] 完成平台条款/权限核对和正式版本发布。

当前没有部署到 Cloudflare、没有发布 V1.0 正式版，不能将代码完成、Git 推送或 dry-run 当作上述验收通过。
