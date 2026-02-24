<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>加入我们的 Discord，获取帮助、反馈和讨论！</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

基于官方 [Dokploy](https://github.com/Dokploy/dokploy) 的社区增强版，增加了：

- **多语言界面（i18n）** — 支持 20+ 种语言
- **内置 AI 助手面板** — Chat / Agent、工具调用审批、MCP Server
- **卷备份（Volume Backups）** — 定时备份 Docker 卷/绑定挂载到外部存储，支持恢复

> 官方文档：[docs.dokploy.com](https://docs.dokploy.com)

---

**语言 / Languages**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[更多…](./)

---

## 目录

- [快速开始](#快速开始)
- [卷备份](#卷备份)
- [AI 助手面板](#ai-助手面板)
- [许可证](#许可证)

## 快速开始

> 要求：root 权限，端口 `80/443/3000` 空闲，基于 Docker Swarm

| 场景 | 命令 |
|------|------|
| **通用环境** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **数据落盘到 `/data`** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **国内网络加速** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **国内 + 数据落盘**（推荐） | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

安装后访问：`http://<your-server-ip>:3000`

## 卷备份

官方 Dokploy 仅支持数据库备份。本 fork 新增 **卷备份（Volume Backups）**，可对应用、Compose、数据库等任意服务的 Docker 卷和绑定挂载进行定时备份与恢复。

**入口**：进入任意应用/服务详情页 → `卷备份` 标签页

**能力**：
- 按 Cron 表达式定时自动备份到 S3 等外部存储
- 支持 Docker Named Volume、绑定挂载（Bind Mount）、一键备份全部挂载
- 可配置保留最近 N 份备份，自动清理旧备份
- 备份前可选停止容器以保证数据一致性
- 支持从备份恢复

## AI 助手面板

**入口**：登录 仪表盘 → 点击右下角机器人按钮

**启用**：`仪表盘 → 设置 → AI`（`/dashboard/settings/ai`）→ 新增 AI Provider（支持 OpenAI / Anthropic / Gemini / Ollama 等）

**能力**：
- Chat / Agent 两种模式
- 工具调用审批：可中断流式输出并取消后端 run
- MCP Servers：面板内直接管理，对话中可被调用

### pgvector 依赖

启用 Embedding / 向量检索能力需要 PostgreSQL 支持 `pgvector`。若 `dokploy-postgres` 仍为 `postgres:16`，可升级：

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## 许可证

基于上游 Dokploy（Apache-2.0），详见 [LICENSE.MD](../../LICENSE.MD)。

## 贡献

见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。
