# Dashboard 只读 API

本接口让另一台设备上的独立 dashboard 读取 planner 的日程与课程。它绑定一个**展示账户**，遵守该账户当前的分享设置；不能写入任务、课表或其他数据。所有日期与未附时区的任务时间按 `Asia/Shanghai` 理解。

## 开通和保存凭据

1. 管理员在 planner 的“分享管理”中创建展示账户，并绑定日程所有者。
2. 日程所有者为该展示账户保存分享设置：开启分享、选择分类和日期范围，按需允许已完成任务、备注和课表。dashboard API 不返回每日手记，即使展示页允许分享手记。
3. 在同一展示账户的“Dashboard 只读 Token”区域输入**日程所有者自己的当前密码**，点击“生成／轮换”。复制新 Token；它只显示这一次。
4. 将 Token 作为机密配置保存在 dashboard **服务端**。由服务端在请求头中携带 Token，不要放进浏览器 JavaScript、HTML、URL、Git 或日志。只有静态网页的 dashboard 需要增加服务端代理。

一个展示账户同时只保留一个有效 Token。轮换立即撤销旧 Token；“撤销”、停用展示账户或重新绑定到其他所有者会阻止原 Token 访问。暂停分享或收窄授权会在后续请求立即生效，但 Token 本身不会自动撤销；暂停时接口成功返回空内容，方便 dashboard 区分“暂时无权限展示”和“凭据失效”。

跨设备访问应使用 HTTPS。Token 存在数据库中的是 SHA-256 摘要；数据库和备份仍应当作为敏感数据保护。生产环境的反向代理建议对 `/api/v1/agenda` 设置请求速率上限。接口不支持浏览器跨域凭据共享，也不返回 `Access-Control-Allow-Origin`。

## 请求约定

所有请求使用：

```http
Authorization: Bearer <dashboard-token>
```

不要发送 planner 的 Cookie 或 CSRF Token。只允许 `GET`；其他方法返回 `405`。凭据缺失、无效、被撤销，或展示账户停用时返回 `401`。响应设置 `Cache-Control: no-store`。错误响应是 `{"error":"说明"}`。

### `GET /api/v1/agenda`

按日期读取任务与实际课程。例如：

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $PLANNER_DASHBOARD_TOKEN" \
  'https://planner.example.org/api/v1/agenda?from=2026-09-15&to=2026-09-20'
```

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `from` | 是 | 起始日期，严格 `YYYY-MM-DD` |
| `to` | 是 | 结束日期，包含当天；范围最多 31 天 |
| `include` | 否 | `tasks`、`courses` 或 `tasks,courses`；默认两者都返回 |

未知参数、重复参数、无效日期、逆序或超长范围返回 `400`。API 不按任务分类、完成状态或备注再筛选：这些始终由展示账户分享设置决定；dashboard 可以对已授权结果做本地筛选。计划区间与查询区间相交的任务会被返回并裁剪到查询范围。`continues_before` / `continues_after` 标明它在查询或授权范围外仍有延续；跨日分钟任务在裁剪边界使用 `00:00` / `23:59`。

响应结构示例（值仅作格式说明）：

```json
{
  "timezone": "Asia/Shanghai",
  "generated_at": "2026-09-24T08:00:00+00:00",
  "requested_range": {"from": "2026-09-15", "to": "2026-09-20"},
  "authorized_range": {"from": "2026-09-15", "to": "2026-09-20"},
  "share_enabled": true,
  "busy_only": false,
  "tasks": [{
    "id": "示例ID", "title": "准备周会", "category": "科研",
    "date": "2026-09-16", "end_date": "2026-09-17",
    "start_time": "", "end_time": "", "due": "2026-09-18T15:00",
    "done": false, "notes": "", "continues_before": false,
    "continues_after": false
  }],
  "courses": [{"date": "2026-09-16", "name": "课程名", "time": "08:00–09:50", "room": "教室"}],
  "date_counts": []
}
```

`courses` 是**个人已导入课表**按学期起始日、星期、单双周和起止周展开后的课程实例，不是公共课程模板。未导入课表、未授权课表或该区间无课时返回空数组。

`due` 是任务自己的独立截止时间，不随计划区间裁剪；但如果它落在分享授权日期之外，会返回 `null`。没有 DDL、或仅占用模式隐藏 DDL 时也返回 `null`。`notes` 仅在分享设置允许时有内容。仅占用模式沿用展示页脱敏逻辑：任务名、分类、原始 ID、备注、DDL 与课程地点不会泄露；日期级任务可能被汇总到 `date_counts`，所以 dashboard 应同时读取它。`include` 未选中的数组仍返回 `[]`。

### `GET /api/v1/agenda/meta`

返回学期及可见分类的展示配置：

```json
{
  "timezone": "Asia/Shanghai",
  "generated_at": "2026-09-24T08:00:00+00:00",
  "semester": {"name": "2026 秋季学期", "start": "2026-09-07"},
  "categories": [{"name": "科研", "color": "#408f80"}],
  "share": {"enabled": true, "busy_only": false,
            "from": "2026-09-15", "to": "2026-09-20"}
}
```

`categories` 只含获准展示的分类；仅占用模式下可能包含脱敏分类名。暂停分享时，分类和日程为空，学期及授权范围字段为空字符串。`share.from/to` 是当前实际分享范围，可随“本周／两周”设置自动滚动。dashboard 不应通过请求更大日期范围推断未授权的数据。

## Dashboard 侧建议

- 启动时读取一次 `meta`，显示学期和授权状态；日程按可见日期范围调用 `agenda`。如需“未来 N 天 DDL”列表，应先取得覆盖有关任务计划日期的授权区间，再由 dashboard 根据返回的 `due` 计算。**仅靠 DDL 落在查询范围内，不能检索计划日期在范围外的任务。**
- dashboard 服务端可以做很短的私有缓存，但要考虑分享暂停或撤销的生效延迟；不要使用公共 CDN 缓存。请求失败时显示上次成功更新时间，避免把旧日程当成最新内容。
- 课程的 `time` 当前是原课表的显示字符串，通常形如 `08:00–09:50`；它不是 ISO 时间区间。dashboard 若要做精确冲突判断，应解析并校验这两个时刻。
- 当前接口为 `v1`。后续如需改动字段语义，应新增版本，不在原接口里静默改变含义。

## 本地验证

测试使用临时 SQLite 数据库和本地 HTTP 服务，不读取生产数据库：

```sh
python3 -m unittest discover -s tests -q
```

部署前仍需在真实代理环境验证 HTTPS、请求头传递、限速和凭据保存方式；本地测试不覆盖这些部署行为。
