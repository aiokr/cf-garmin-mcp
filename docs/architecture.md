# 架构

需求来源：[V1.0 技术方案](https://app.notion.com/p/4246531e06a281798caec1f314073ec9)，2026-11-26 读取。当前 `1.0.0-dev.0` 为待真实联调的实现版本。

## 部署边界

pnpm workspace 中保留 Web、Worker、shared 边界，根配置部署一个 Cloudflare Worker。Vue 使用 Workers Static Assets；所有请求先经过安全头中间件，API/MCP/discovery 优先处理，其他路径 SPA fallback。未知 API 返回 JSON 404，协议路由不会退回 HTML。

D1 保存身份、衍生 token 密文、摘要、游标和授权；R2 私有归档 FIT；Durable Objects 管理实例限速、每连接认证队列和 OAuth 变更队列；Cron 只安排任务，Workflows 执行持久化步骤。

## 三层身份

应用身份由 Better Auth 1.7.28 原生 D1 adapter 维护。关闭注册配置并使用 HTTP 路由白名单，D1 触发器进一步拒绝第二个用户。bootstrap 经 Origin、部署密钥、输入校验和限速后，以 D1 batch 原子插入 user/account/永久初始化状态。保留内部 UUID 和 role 扩展字段，未开放多用户接口。

Garmin 原始凭据只来自环境。配置严格互斥；域名按 CN/GLOBAL 固定。密码模式独立移植 python-garminconnect 0.3.20 的 Mobile SSO/DI 协议；不引入 Python、TLS impersonation 或验证码绕过。上游阻止时停止。

GarminAuth DO 对网络 await 使用显式 Promise 队列。每次读取 D1 状态和 token，不保留脱离数据库的明文缓存；到期续期后验证稳定账号 ID 再持久化，401 只刷新重试一次。环境指纹变更要求 Owner 显式验证；身份变更要求新 connection id。解绑与读取排队，解绑完成后即使环境 Secret 仍存在也不能自动重绑。

MFA challenge 随机 ID 绑定 Owner session、连接、区服和凭据指纹，10 分钟 TTL、最多 5 次；临时 Cookie 加密保存在 DO，仅向 Web 返回非敏感 challenge 元数据，成功/到期清理。

## MCP 授权

只使用 Better Auth OAuth Provider，启用动态注册、S256 PKCE、authorization_code/refresh_token 两种 grant 和 `/mcp` resource。使用不透明 access token，数据库仅存散列；每请求检查 token、有效期、原会话、Owner、客户端状态、consent、scopes 和 resource。没有 JWT 离线撤销延迟，不支持未验证的 DPoP token。

OAuthCoordinator 将授权码、token 交换/刷新、consent 与应用撤销串行化。撤销使用 D1 batch 清除该 user/client 的 access token、refresh token、consent 和未消费授权码，避免并发 refresh 在撤销之后重新提交。不会全局注销 Owner 或其他客户端。

MCP SDK 使用 Web-standard Streamable HTTP、无服务器端传输 session、JSON 响应。每个工具调用重新验证授权，读取完数据再校验一次，只记录最近成功工具访问时间。tools/list 按 scope 过滤，直接调用仍校验权限。业务服务和 REST 共用查询/单位口径。

## 数据一致性

活动按 connection/external ID 幂等写入；健康/训练按 connection/calendar date 唯一。所有查询从认证 Owner 解析连接，不接受用户自报 user id；默认连接为当前账号，历史按 connection id 分离。

UTC 保存发生时间，保留 Garmin local date；日健康使用 Garmin calendar date。标准单位为米、秒、m/s、W、bpm；缺失为 NULL，真实零值保留，负数缺失哨兵归空。时间区间缺失日期显式返回空指标，不压缩时间轴。部分接口临时不可用时保留先前有效值并记录原采集时间及可用性。

先写 R2、验证对象，再提交 ready 文件索引；不可假设 D1/R2 之间存在事务。FIT 使用 MIT 许可 fit-file-parser，启用严格结构与 CRC 校验；ZIP 限制体积、压缩比例和选中文件数。不可变键包含 SHA-256，下载/解析时重新校验内容；曲线、分段和 GPS 按需从原始 FIT 解析，逐秒数据不入 D1。

增量使用重叠窗口，游标只在完成窗口后提交，历史补录不使游标倒退。近期数据优先，随后按设置补录历史。每 stream 的活动任务由 D1 唯一索引防重。429 通过 Workflow sleep 尊重 Retry-After，网络/5xx 有限重试；长期认证失效暂停后续读取。文件失败单独重试；周度扫描恢复可验证的孤儿文件索引、标记缺失对象，旧文件版本默认保留。

## Web

Vue Router 按页面加载，地图再按交互加载。Base UI Vue 提供控件基础，全部图标来自 Lucide（含 favicon）；ECharts 使用品牌语义色，MapLibre 加载可配置 OSM raster tiles。轨迹本地渲染，不上传 GPS 给瓦片服务；显示 OpenStreetMap 版权。主题和样式 token 集中定义，系统字体，无外部字体/分析请求。产品界面只保留必要表单、状态与错误文案。
