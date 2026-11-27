# 安全边界与恢复

## 应用与授权

常规公开注册在 Better Auth 配置和 HTTP handler 中关闭，D1 单用户约束阻止第二个用户。仅未初始化实例开放首次 Owner 创建：无需 bootstrap key，以名字、邮箱和密码创建；请求仍须通过规范 Origin、输入校验与限流。D1 batch 保证 user/account/永久初始化标志一起提交，并发时只能有一个请求成功；初始化后永久关闭创建入口。任何请求不能自报 user id、role 或加密上下文。

**首访抢占是明确的安全取舍：未初始化时，任何能访问该实例的人都可能先成为 Owner；规范 Origin 和限流并不能认证部署者。** 部署后应立即完成初始化，在此之前不要公开或分享 URL；需要保障时在外围限制所有入口，包括 workers.dev 和自定义域名。若已被抢占，不要通过删除用户或初始化标志重新开放创建，应由有 Cloudflare/数据库权限的部署者按维护恢复流程处置。

Cloudflare 部署脚本为缺失的 `BETTER_AUTH_SECRET` 和 `PROVIDER_ENCRYPTION_KEY` 生成独立安全随机值，并持久保存为 Worker Secret；已有 Secret 在重建/部署中保留，不因部署自动轮换。密钥不进入普通 vars、Git 或日志；provider key 必须安全备份，丢失后无法解密已有 Garmin token。不要将内部密钥作为首次创建 Owner 的人工输入，也不要保留对 `BOOTSTRAP_SECRET` 的依赖。

InstanceGuard 持久化限制初始化每分钟 5 次、登录 10 次、OAuth 协议 30 次，Better Auth 额外启用数据库限流。全实例限速可能暂时影响 Owner，可在外围再配置精确限流。

生产使用 HTTPS、Secure/HttpOnly/SameSite=Lax Cookie、Origin 校验、no-store、CSP 和请求体/区间/分页上限。公网应用密码重置和注册端点均不开放。业务错误仅含稳定 code/requestId，不返回上游响应和内部栈；应用 logger 和 Cloudflare observability 默认关闭，无内置遥测。启用平台日志前自行检查采集字段。

## Garmin

原始密码/API Key 只来自 Cloudflare Secret bindings（模板由 `.dev.vars.example` 提示，只填所选模式的一组；本地为 gitignore 的 .dev.vars），Owner 登录后仍须在设置页连接和完成 MFA；数据库仅存 AES-256-GCM 衍生 token，随机 96-bit IV、版本化 key，AAD 绑定 Owner/connection/provider/region/purpose。原始凭据和 MFA code 不记录日志或写入浏览器存储。

MFA pending Cookie 加密保存在 DO，随机 challenge 绑定原会话，TTL 10 分钟、最多 5 次。配置或区服变更须重新验证，不同账号不能沿用旧连接。断开后清除密文和临时状态，暂停同步；环境凭据存在也不能自动重绑。

FIT 为私有 R2 对象，所有读取经 Owner 或 scope/归属校验。解析验证结构、CRC、大小、压缩比例和 SHA-256，轨迹从 Web 单独请求。OSM 瓦片请求会暴露浏览区域给瓦片提供方，GPS 轨迹本身在本应用渲染，不上传。

## MCP

只读 OAuth 2.1 授权，S256 PKCE、精确 redirect URI 与 signed consent query、resource/scopes。动态客户端名称不可信，授权页显示 ID 和回调目的地，不加载第三方 logo。

每次 MCP 请求查询 D1 的 token hash、有效期、客户端、会话、Owner、consent 与 resource；所有工具再次检查所需 scope。普通活动裁剪 GPS、地点型标题和未授权心率/热量，睡眠单独授权。原始 FIT 仅 Web 下载，避免在当前 MCP 暴露复合敏感文件。

OAuth token 交换/刷新与撤销串行化，撤销只清除指定 Owner/client 的 token、consent 和未消费代码。不会注销其他客户端或 Garmin。已经读取的数据无法收回。

## 部署者恢复 Owner

仅有 Cloudflare 部署/数据库权限的人可操作。先进入维护状态阻止新登录，并备份数据库；脚本先清除现有 Owner 会话，再更新密码，维护期间不要允许并发登录。它不重新开放 bootstrap 或注册。

在权限 0600 的本地临时 JSON 文件写入 `{ "password": "至少12字符的新密码" }`，不要在命令参数、聊天或 shell 历史中写密码：

```sh
pnpm owner:recover --local < /private/tmp/protected-password.json
# 生产维护状态下显式使用 --remote。
```

脚本读取 stdin、用 Better Auth hashPassword 在本机散列，仅散列进入 0600 临时 SQL，执行后删除临时 SQL。操作后删除输入 JSON；验证旧会话、旧密码失败，新密码成功，再恢复流量。不要删除用户或 instance_state 来重置账户。

## 验收边界

本地测试使用合成健康、GPS 和凭据，不能证明 Garmin 服务当前可用。实际四组合认证、真实 MFA/续期、两个实际 AI 客户端的授权撤销、生产资源权限和空账户部署，均需在正式发布前另行验证。详见 implementation.md。
