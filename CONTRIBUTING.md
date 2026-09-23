# 贡献说明

本项目采用 AGPL-3.0-only，提交贡献前请阅读 LICENSE。贡献应具有可按本项目许可证发布的授权。建议针对一个问题提交一个改动，避免混入无关重构。

提交采用 Conventional Commits 风格，例如：

- `feat(calendar): compact non-overlapping task ranges`
- `fix(sharing): omit deadlines from busy-only projection`
- `docs: clarify backup restoration`
- `test(auth): cover username conflicts`
- `chore: update repository exclusions`

按改动范围运行必要检查。涉及权限、迁移或隔离时使用临时数据库测试；不要用真实账号与生产数据库写测试。不提交数据库、真实课表、真实地址、邮箱、SSH 配置或密码。示例凭据必须明确标为演示用途。

代码 review 需要说明用户行为变化、必要验证和已知限制。发布前核对贡献来源、版权署名及实际发布版本的源码获取入口。
