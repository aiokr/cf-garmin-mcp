# 安全边界与恢复

## 应用与授权

公开注册同时在 Better Auth 配置、HTTP handler 和 D1 单用户约束中关闭。Bootstrap 必须有规范 Origin 和一次性部署密钥；D1 batch 保证 user/account/永久初始化标志一起提交。任何请求不能自报 user id、role 或加密上下文。

InstanceGuard 持久化限制初始化每分钟 5 次、登录 10 次、OAuth 协议 30 次，Better Auth 额外启用数据库限流。全实例限速可能暂时影响 Owner，可在外围再配置精确限流。

生产使用 HTTPS、Secure/HttpOnly/SameSite=Lax Cookie、Origin 校验、no-store、CSP 和请求体/区间/分页上限。公网应用密码重置和注册端点均不开放。业务错误仅含稳定 code/requestId，不返回上游响应和内部栈；应用 logger 和 Cloudflare observability 默认关闭，无内置遥测。启用平台日志前自行检查采集字段。

## Garmin

原始密码/API Key 只来自 Cloudflare Secret bindings（本地为 gitignore 的 .dev.vars）；数据库仅存 AES-256-GCM 衍生 token，随机 96-bit IV、版本化 key，AAD 绑定 Owner/connection/provider/region/purpose。原始凭据和 MFA code 不记录日志或写入浏览器存储。

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
