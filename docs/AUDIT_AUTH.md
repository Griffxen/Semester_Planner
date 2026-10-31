# 认证与操作日志

## 工作台

个人规划、操作日志与管理区共用界面。`user.admin` 表示附加的管理资格，`state.auth.admin_unlocked` 表示本次会话的管理授权；前端隐藏按钮不能代替后端授权。展示账户不访问操作日志。

密码至少 12 位；PIN 为 4–6 位数字，作为字符串保存，允许前导零。未完成首次设置的账户，旧密码验证成功后只发放 10 分钟设置会话；完成前不能访问规划、分享、日志或管理功能。展示账户设置后仍只读，可维护自己的 PIN 和设备。分享预览不允许修改账户安全设置。

## 认证接口

所有写接口使用 JSON 和当前 `X-CSRF-Token`，登录除外。

| 接口 | 用途 |
| --- | --- |
| `POST /api/login` | `name` 与 `credential`，自动验证密码或可信设备 PIN；兼容旧 `password` 字段 |
| `GET /api/auth/context` | 当前认证状态与 CSRF，不刷新管理闲置时间 |
| `POST /api/auth/setup` | 设置会话内一次提交 `password`、`pin`、可选 `trust_device`（默认 false）和 `label` |
| `POST /api/auth/verify` | `password`，重新验证强密码、轮换会话与 CSRF；有资格时解锁管理 |
| `DELETE /api/auth/admin` | 锁定管理，保留规划会话 |
| `POST /api/auth/password` | `current_password` 与新 `password`；支持旧密码本人升级 |
| `PUT /api/auth/pin` | 设置或修改 `pin` |
| `DELETE /api/auth/pin` | 关闭 PIN |
| `GET /api/auth/devices` | 本人的有效可信设备，不返回令牌摘要 |
| `POST /api/auth/devices` | 主动信任此设备，`label` 为设备名 |
| `DELETE /api/auth/devices/{id}` | 撤销本人设备及关联会话 |
| `PUT /api/admin/users/{id}/permission` | `admin` 布尔值，授予或撤销管理资格 |

认证响应可能带新的 `csrf`、`auth` 和多条 `Set-Cookie`，客户端应更新 CSRF 后再继续请求。敏感接口要求 5 分钟内验证过密码，也可提交 `current_password` 当场验证。`password_required` 要求再次验证，`strong_password_required` 要求本人升级密码，`management_auth_required` 要求管理资格和有效管理授权。

待首次设置时，登录与认证上下文返回 `setup_required: true`、`setup_url: /setup/` 和最小账户身份；业务接口返回 `403 auth_setup_required`。仅认证上下文、首次设置和退出可用。`user_auth.setup_version` 保存完成版本，普通 PIN 更新保留此标记；管理员重置凭据后重新进入首次设置。

`user.root_admin` 表示受保护站点所有者。权限接口不能撤销其管理资格，旧账户重置接口不能重置根管理员密码；本人使用自助修改接口。成功访问管理接口首次记录 `management_verified`，用于区分设置成功与实际管理接管。

规划会话固定最长 7 天；PIN 会话同时受可信设备期限限制。设备凭据保存在随机 HttpOnly Cookie 中，服务器仅保存摘要，固定 30 天到期。管理授权闲置 30 分钟或累计 2 小时后锁定，普通读取状态的轮询不延长闲置时间。

密码变更撤销全部会话与设备信任；PIN 变更撤销旧设备和关联会话，当前浏览器保留规划身份，需重新信任。管理撤权立即清除目标的管理授权，保留规划。最后管理员保护在数据库写事务内原子执行。

## 日志接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/audit/months` | 权限范围内各月记录数量 |
| `GET /api/audit/events` | 分页摘要 |
| `GET /api/audit/events/{id}` | 完整字段差异 |
| `GET /api/audit/export` | 导出完整月份或当前筛选结果 |
| `GET /api/admin/storage` | 数据库、备份、磁盘及月份内容用量 |
| `GET /api/admin/api-reads` | Dashboard API 调用统计、每日汇总与分页读取记录 |
| `GET /api/admin/api-reads/export` | 导出指定月份的 API 读取记录 |

共同参数：`month=YYYY-MM`（默认当前北京时间自然月）、`group`、`type`、`action`、`q`、`user_id`、`scope=mine|all`。`all` 需要管理资格与有效管理授权。界面使用五种 `group`：`account` 账户操作、`task` 任务变更、`course` 课程变更、`settings` 手记与设置、`management` 管理操作；事件同时返回 `group`。底层 `type` 仍保留精细业务类型供兼容查询。

列表默认 50 条，`limit` 最多 100。响应包含 `events`、`next_cursor`、`snapshot_id`；下一页原样提交游标和筛选。导出通过 `format=csv|json` 选择格式，并携带列表的 `snapshot_id` 固定边界。JSON 保留完整事件和结构化差异；CSV 为带 BOM 的 UTF-8，并处理公式前缀。

个人范围包括本人操作及本人数据受到的修改。管理员低认证会话不能通过历史操作读取全站模板或他人数据；管理记录仍可在解锁后的全站范围查询。事件记录时保存当时的名称，用户改名不改写历史。

数据库内以 UTC 保存时间，月份按北京时间月初至下月月初的半开区间筛选。日志与业务操作在同一写事务提交；版本号变化本身不产生修改事件。冲突或异常不记为业务成功。认证失败可记录为单独的失败事件。

日志长期保留；删除业务对象不会清除对应历史。密码、PIN、会话、Cookie、设备凭据、Dashboard Token 及其摘要均不进入记录或导出。服务器异常仅记录请求编号、路径、状态、耗时和堆栈，不记录请求正文。

API 读取统计独立于操作流水，两个新增接口均要求有效管理授权。支持 `month`、`endpoint=agenda|meta`、`viewer_id` 筛选；列表使用 `limit`、`cursor`、`snapshot_id`，导出使用 `format=csv|json` 和相同快照。汇总包含调用总数、成功／失败数、成功率（0–100）、平均与最大处理毫秒数，以及每天成功／失败数；分页不改变汇总口径。记录只保存固定标量元数据和返回数量，不保存 Token、请求参数或返回正文。

## 容量与备份

月份用量是事件序列化内容体积，数据库页及索引按整个库统计。备份规则见 [部署说明](DEPLOYMENT.md)：只轮换新 `planner-managed-` 文件，保留 30 天日备与 12 个月月备的并集。既有历史备份不自动删除。

迁移只新增表和字段，部署时撤销旧会话及设备信任，所有现有网页账户首次登录重新完成设置。日志从启用后开始记录，不重建历史修改，也不改动已有个人日程或 Dashboard Token。
