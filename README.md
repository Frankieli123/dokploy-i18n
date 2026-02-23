<div align="center">
  <a href="https://dokploy.com">
    <img src=".github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />
  <p>Join us on Discord for help, feedback, and discussions!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

基于官方 Dokploy 的社区增强版，增加了：

- 多语言界面（i18n）
- 内置 AI 助手面板（AI Panel）：Chat / Agent、工具调用审批、MCP Server 等

上游项目：`dokploy/dokploy`  
官方文档：`https://docs.dokploy.com`

## 语言 / Languages

多语言 README 位于 `docs/readmes/`：

- 简体中文: `docs/readmes/README-zh-Hans.md`
- 繁体中文: `docs/readmes/README-zh-Hant.md`
- English: `docs/readmes/README-en.md`
- 其他语言: 见 `docs/readmes/`

## 快速开始（Linux 一键安装）

要求：

- root 权限
- 端口 `80/443/3000` 空闲
- 安装方式基于 Docker Swarm

通用环境：

```bash
curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh | bash
```

数据落盘到 `/data`（更方便备份与迁移）：

```bash
curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh | bash
```

国内网络环境（配置 Docker registry mirrors，加速拉取镜像）：

```bash
curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh | bash
```

国内网络环境 + 数据落盘到 `/data`（推荐给国内服务器）：

```bash
curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh | bash
```

说明：

- `install-china.sh`: 仅配置 Docker registry mirrors（国内网络加速拉取镜像）
- `install-data*.sh`: 将 Dokploy 持久化数据与 Docker data-root 迁移到 `/data`（可用 `DOKPLOY_DATA_DIR` / `DOCKER_DATA_ROOT` 调整）
- `install-data-china.sh`: 同时配置 registry mirrors；若本机 Docker 已存在状态，脚本会拒绝自动迁移 data-root（可设置 `FORCE_DOCKER_DATA_ROOT_CHANGE=1` 强制，但有风险）

可选：指定版本（例如 `canary` / `feature` / `latest`）：

```bash
DOKPLOY_VERSION=canary bash install.sh
```

安装后访问：`http://<your-server-ip>:3000`

## 国内网络环境加速配置（可选）

### 更新检查地址（tags URL）

Dokploy 会通过镜像 tags 列表 API 判断是否有新版本。默认请求 Docker Hub：

```text
https://hub.docker.com/v2/repositories/a3180623/dokploy-i18n/tags
```

在国内若 Docker Hub 访问不稳定，可在 Web UI 配置一个可访问的镜像地址：

- `Dashboard -> Settings -> Server -> Web Server -> Update -> Update Source`

要求：

- 该 URL 需兼容 Docker Hub tags API 返回结构，至少包含 `results: [{ name, digest }]` 与 `next`（分页）。
- 若镜像返回的 `next` 仍指向 Docker Hub，Dokploy 会尽量将其 origin 重写为你设置的 `tags URL`，以便继续从镜像分页拉取。

相关环境变量：

- `DOKPLOY_UPDATE_FETCH_TIMEOUT_MS`: 更新检查请求超时（默认 `8000`，单位毫秒）
- `RELEASE_TAG`: 当前运行的 tag（默认 `latest`）。如果你固定运行某个版本（例如 `v0.27.0-i18n`），建议同步设置该环境变量，否则更新判断会按 `latest` 逻辑计算。

### GitHub 克隆加速（Mirror Prefix / API Proxy）

当服务器无法稳定访问 GitHub 时，可在 GitHub Provider 中配置（用于 `git clone` 与 GitHub API）：

- `Dashboard -> Settings -> Git Providers -> GitHub -> Edit`

字段说明：

- `Mirror Prefix URL (Git Clone)`: 给 clone URL 增加前缀，例如配置为 `https://ghproxy.com/`，实际 clone 会变为 `https://ghproxy.com/https://github.com/<owner>/<repo>.git`。
- `GitHub API Proxy URL`: GitHub API 代理地址，同时也会注入到 clone 流程的 `http_proxy/https_proxy`（示例：`http://127.0.0.1:7890`）。
- `Allow forwarding GitHub auth through Mirror Prefix`: 把 GitHub App installation token 通过请求头带给镜像前缀。仅对可信/自建镜像开启（否则存在泄露风险）。未开启时，镜像 clone 默认不携带 token，私有仓库可能无法克隆。

## AI 助手面板（重点）

入口：

- 登录 Dokploy Dashboard
- 点击右下角机器人按钮打开 AI 面板

启用（必须先配置 Provider）：

- 进入 `Dashboard -> Settings -> AI`（路径：`/dashboard/settings/ai`）
- 新增一个 AI Provider（支持 OpenAI / OpenAI-compatible / Anthropic / Gemini / Ollama 等，取决于你的配置与可用性）

能力概览：

- Chat / Agent 两种模式
- 工具调用审批：发送按钮会变为 Stop，可中断流式输出并尽量取消后端 run
- MCP Servers：AI 面板内可直接管理 MCP Server，并在对话中被调用

### AI 依赖：pgvector（重要）

若要启用/使用 Embedding、向量检索等能力，PostgreSQL 需要支持 `pgvector`。

如果你已部署过，并且 `dokploy-postgres` 仍为 `postgres:16`，可以升级为 `pgvector/pgvector:pg16`：

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## 许可证 / License

本仓库基于上游 Dokploy（Apache-2.0）。具体以 `LICENSE.MD` 为准。

## Contributing

见 `CONTRIBUTING.md`。
