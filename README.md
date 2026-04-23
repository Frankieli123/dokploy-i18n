<div align="center">
  <a href="https://dokploy.com">
    <img src=".github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Join us on Discord for help, feedback, and discussions!</p>
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
[简体中文](docs/readmes/README-zh-Hans.md) |
[繁體中文](docs/readmes/README-zh-Hant.md) |
[English](docs/readmes/README-en.md) |
[日本語](docs/readmes/README-ja.md) |
[한국어](docs/readmes/README-ko.md) |
[Русский](docs/readmes/README-ru.md) |
[更多…](docs/readmes/)

---

## 目录

- [快速开始](#快速开始)
- [卷备份](#卷备份)
- [国内网络加速配置](#国内网络加速配置)
- [AI 助手面板](#ai-助手面板)
- [许可证](#许可证)

## 快速开始

> 要求：root 权限 · 端口 `80/443/3000` 空闲 · 基于 Docker Swarm

| 场景 | 命令 |
|------|------|
| **通用环境** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **数据落盘到 `/data`** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **国内网络加速** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **国内 + 数据落盘**（推荐） | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

<details>
<summary>安装脚本说明</summary>

- `install-china.sh` — 配置 Docker registry mirrors（国内加速拉取镜像）
- `install-data*.sh` — 将 Dokploy 持久化数据与 Docker data-root 迁移到 `/data`（可用 `DOKPLOY_DATA_DIR` / `DOCKER_DATA_ROOT` 调整）
- `install-data-china.sh` — 同时配置 registry mirrors；若本机 Docker 已存在状态，脚本会拒绝自动迁移 data-root（可设置 `FORCE_DOCKER_DATA_ROOT_CHANGE=1` 强制，但有风险）

指定版本（例如 `canary` / `feature` / `latest`）：

```bash
DOKPLOY_VERSION=canary bash install.sh
```

</details>

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

## 国内网络加速配置

<details>
<summary>更新检查地址（tags URL）</summary>

Dokploy 通过镜像 tags 列表 API 判断是否有新版本。默认请求 Docker Hub：

```
https://hub.docker.com/v2/repositories/a3180623/dokploy-i18n/tags
```

在国内若 Docker Hub 访问不稳定，可在 Web UI 配置镜像地址：

**路径**：`Dashboard → Settings → Server → Web Server → Update → Update Source`

要求：
- URL 需兼容 Docker Hub tags API 返回结构，至少包含 `results: [{ name, digest }]` 与 `next`（分页）
- 若镜像返回的 `next` 仍指向 Docker Hub，Dokploy 会将其 origin 重写为你设置的 tags URL 以继续分页拉取

相关环境变量：
- `DOKPLOY_UPDATE_FETCH_TIMEOUT_MS` — 更新检查超时（默认 `8000`，毫秒）
- `RELEASE_TAG` — 当前运行的 tag（默认 `latest`）。若固定运行某版本（如 `v0.28.8-i18n.14`），建议同步设置

</details>

<details>
<summary>GitHub 克隆加速（Mirror Prefix / API Proxy）</summary>

当服务器无法稳定访问 GitHub 时，可配置：

**路径**：`Dashboard → Settings → Git Providers → GitHub → Edit`

| 字段 | 说明 |
|------|------|
| **Mirror Prefix URL (Git Clone)** | 给 clone URL 增加前缀，如 `https://ghproxy.com/`，实际 clone 变为 `https://ghproxy.com/https://github.com/<owner>/<repo>.git` |
| **GitHub API Proxy URL** | GitHub API 代理地址，同时注入 clone 流程的 `http_proxy/https_proxy`（如 `http://127.0.0.1:7890`） |
| **Allow forwarding GitHub auth through Mirror Prefix** | 将 GitHub App installation token 通过请求头带给镜像前缀。仅对可信/自建镜像开启，否则存在泄露风险 |

</details>

## AI 助手面板

**入口**：登录 Dashboard → 点击右下角机器人按钮

**启用**：`Dashboard → Settings → AI`（`/dashboard/settings/ai`）→ 新增 AI Provider（支持 OpenAI / Anthropic / Gemini / Ollama 等）

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

基于上游 Dokploy（Apache-2.0），详见 [LICENSE.MD](LICENSE.MD)。

## Contributing

见 [CONTRIBUTING.md](CONTRIBUTING.md)。
