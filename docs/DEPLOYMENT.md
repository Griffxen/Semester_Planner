# 部署、备份与恢复

## 安装

需要 Python 3.12+、SQLite 支持，以及用于外部访问的反向代理。所有主机名均是占位符。

1. 创建无登录权限的 `planner` 系统用户。
2. 将代码放入 `/opt/semester-planner`，运行账号只需读取代码；创建由该账号拥有的 `/var/lib/semester-planner`，权限 700。
3. 使用空生产数据库创建首个管理员：

   ```sh
   sudo -u planner env PLANNER_DB=/var/lib/semester-planner/planner.db \
     python3 /opt/semester-planner/app.py --create-user admin
   ```

4. 安装 `deploy/planner.service`，按实际安装路径调整后启用服务。
5. 选用 Caddy 自动 HTTPS 或 Nginx 配合已有 TLS 入口。`nginx.conf` 仅是 HTTP 代理示例，不包含证书配置；`planner.service` 默认启用 Secure Cookie，纯 HTTP 调试需明确设 `PLANNER_SECURE=0`，否则登录 Cookie 无法正常使用。公网保留 HTTPS 与 Secure Cookie。
6. 安装 `deploy/planner-backup.service` 和 timer，检查输出目录和文件权限，另行配置异机备份与保留周期。

不要把本地数据库、`.private` 或演示凭据上传生产环境。不要用匿名示例 `timetable.json` 覆盖已有私人课程配置；现有数据库中的模板不会自动更新。

## SSH 隧道

```sh
PLANNER_SSH_TARGET=user@host.example.org \
PLANNER_SSH_KEY=/path/to/private-key sh deploy/connect.sh
```

默认本地端口 8766、远程端口 8765，可用 `PLANNER_LOCAL_PORT` / `PLANNER_REMOTE_PORT` 调整。脚本不包含固定主机、用户名或密钥路径。

## 更新

先运行一致性备份，再部署代码。数据库字段迁移在应用启动时执行；后端变更后重启服务。不要覆盖数据库。降级前检查 schema 兼容性，必要时停止服务后恢复更新前备份。

## 备份与恢复

```sh
PLANNER_DB=/var/lib/semester-planner/planner.db python3 backup.py --output /secure/backup/path
```

SQLite 副本含账号、密码摘要、会话和私人内容，不能公开。脚本生成权限 600 的文件，默认不清理历史备份。

恢复时停止服务，保留当前数据库，再用备份替换数据库；恢复属主和权限，清空 `sessions` 表强制重新登录，启动并检查。不要在正在写入时直接复制或替换数据库及其 WAL 文件。

JSON 导出用于个人归档，当前没有网页导入功能，不替代完整数据库备份。
