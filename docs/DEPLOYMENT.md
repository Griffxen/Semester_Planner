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
5. 选用 Caddy 自动 HTTPS，或配置 `deploy/nginx-https.conf`。`deploy/nginx.conf` 仅是受保护网络或隧道内的 HTTP 示例；不要通过它跨设备传输 Dashboard Token。`planner.service` 默认启用 Secure Cookie，纯 HTTP 调试需明确设 `PLANNER_SECURE=0`，否则登录 Cookie 无法正常使用。
6. 安装 `deploy/planner-backup.service` 和 timer，检查输出目录和文件权限，另行配置异机备份与保留周期。

不要把本地数据库、`.private` 或演示凭据上传生产环境。不要用匿名示例 `timetable.json` 覆盖已有私人课程配置；现有数据库中的模板不会自动更新。

## SSH 隧道

```sh
PLANNER_SSH_TARGET=user@host.example.org \
PLANNER_SSH_KEY=/path/to/private-key sh deploy/connect.sh
```

默认本地端口 8766、远程端口 8765，可用 `PLANNER_LOCAL_PORT` / `PLANNER_REMOTE_PORT` 调整。脚本不包含固定主机、用户名或密钥路径。

## 离线服务器的 HTTPS 与手动续签

Web 服务器不能联网时，可在另一台可联网机器上通过 DNS-01 验证域名，签发证书后经 SSH 传输证书和私钥。DNSPod 可使用 [acme.sh 的 TencentCloud DNS API 插件](https://github.com/acmesh-official/acme.sh/wiki/dnsapi2#160-use-tencentcloud-dnspod-api)；其他 DNS 服务商也可使用支持 DNS-01 的客户端。DNS API 凭据只放在签发机器，不放到 Web 服务器或仓库。Let's Encrypt 的 [DNS-01 说明](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)涵盖了离线 Web 服务器的验证方式。

首次部署时，将签发的 `fullchain.pem` 和匹配的 `privkey.pem` 安装到服务器的 `/etc/ssl/semester-planner/`：目录权限 700、私钥 600、所有者 root。复制 `deploy/nginx-https.conf`，把 `planner.example.org` 换成自己的域名，再启用为 Nginx 站点。执行 `nginx -t` 成功后才重新加载 Nginx。确认 Planner 服务的 `PLANNER_SECURE=1`；已有 HTTP 调试覆盖值必须移除。用另一台能到达服务器的设备访问 HTTPS，检查证书信任、页面、HTTP 跳转及无凭据 API 的 `401`。内网域名即使有公开证书，客户端仍需有到达服务器内网地址的网络路径。

本仓库**不安装自动续签任务**。到期前，在签发机器手动更新证书，并导出 `fullchain.pem` 与 `privkey.pem`，再运行：

```sh
sh deploy/deploy-renewed-cert.sh \
  planner.example.org /secure/path/fullchain.pem /secure/path/privkey.pem \
  user@server.example.org /secure/path/ssh-key
```

脚本先检查域名、证书与私钥匹配及至少七天有效期；如果服务器已有同一证书就退出。否则通过 SSH 暂存文件、备份旧证书、安装新文件，并在 `nginx -t` 成功后重新加载；失败时恢复旧证书。它不接触数据库，也不会创建 cron、systemd timer 或 ACME 账户。续签日期由所选 ACME 客户端或证书 `notAfter` 决定；手动模式需要自己记得在到期前执行。

## 更新

先运行一致性备份，再部署代码。数据库字段迁移在应用启动时执行；后端变更后重启服务。不要覆盖数据库。降级前检查 schema 兼容性，必要时停止服务后恢复更新前备份。

## 备份与恢复

```sh
PLANNER_DB=/var/lib/semester-planner/planner.db python3 backup.py --output /secure/backup/path
```

SQLite 副本含账号、密码摘要、会话和私人内容，不能公开。脚本生成权限 600 的文件，默认不清理历史备份。

恢复时停止服务，保留当前数据库，再用备份替换数据库；恢复属主和权限，清空 `sessions` 表强制重新登录，启动并检查。不要在正在写入时直接复制或替换数据库及其 WAL 文件。

JSON 导出用于个人归档，当前没有网页导入功能，不替代完整数据库备份。
