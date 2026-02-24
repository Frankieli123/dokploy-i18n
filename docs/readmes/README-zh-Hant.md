<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>加入我們的 Discord，獲取幫助、反饋和討論！</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

基於官方 [Dokploy](https://github.com/Dokploy/dokploy) 的社群增強版，增加了：

- **多語言介面（i18n）** — 支援 20+ 種語言
- **內建 AI 助手面板** — Chat / Agent、工具呼叫審批、MCP Server
- **卷備份（Volume Backups）** — 定時備份 Docker 卷/綁定掛載到外部儲存，支援還原

> 官方文件：[docs.dokploy.com](https://docs.dokploy.com)

---

**語言 / Languages**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[更多…](./)

---

## 目錄

- [快速開始](#快速開始)
- [卷備份](#卷備份)
- [AI 助手面板](#ai-助手面板)
- [授權條款](#授權條款)

## 快速開始

> 要求：root 權限，連接埠 `80/443/3000` 空閒，基於 Docker Swarm

| 場景 | 命令 |
|------|------|
| **一般環境** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **資料存放至 `/data`** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **中國網路加速** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **中國 + 資料存放**（推薦） | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

安裝後訪問：`http://<your-server-ip>:3000`

## 卷備份

官方 Dokploy 僅支援資料庫備份。本 fork 新增 **卷備份（Volume Backups）**，可對應用、Compose、資料庫等任意服務的 Docker 卷和綁定掛載進行定時備份與還原。

**入口**：進入任意應用/服務詳情頁 → `卷備份` 標籤頁

**功能**：
- 按 Cron 表達式定時自動備份到 S3 等外部儲存
- 支援 Docker Named Volume、綁定掛載（Bind Mount）、一鍵備份全部掛載
- 可設定保留最近 N 份備份，自動清理舊備份
- 備份前可選停止容器以確保資料一致性
- 支援從備份還原

## AI 助手面板

**入口**：登入 儀表板 → 點擊右下角機器人按鈕

**啟用**：`儀表板 → 設定 → AI`（`/dashboard/settings/ai`）→ 新增 AI Provider（支援 OpenAI / Anthropic / Gemini / Ollama 等）

**功能**：
- Chat / Agent 兩種模式
- 工具呼叫審批：可中斷串流輸出並取消後端 run
- MCP Servers：面板內直接管理，對話中可被呼叫

### pgvector 相依性

啟用 Embedding / 向量檢索功能需要 PostgreSQL 支援 `pgvector`。若 `dokploy-postgres` 仍為 `postgres:16`，可升級：

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## 授權條款

基於上游 Dokploy（Apache-2.0），詳見 [LICENSE.MD](../../LICENSE.MD)。

## 貢獻

見 [CONTRIBUTING.md](../../CONTRIBUTING.md)。
