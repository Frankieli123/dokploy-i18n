<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Join us on Discord for help, feedback, and discussions!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Community enhanced version based on official [Dokploy](https://github.com/Dokploy/dokploy), featuring:

- **i18n** — 20+ languages support
- **AI Assistant Panel** — Chat / Agent, tool call approval, MCP Server
- **Volume Backups** — Schedule Docker volume/bind mount backups to external storage, with restore

> Official docs: [docs.dokploy.com](https://docs.dokploy.com)

---

**Languages**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[More...](./)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Volume Backups](#volume-backups)
- [AI Assistant Panel](#ai-assistant-panel)
- [License](#license)

## Quick Start

> Requirements: root privileges, ports 80/443/3000 free, Docker Swarm

| Scenario | Command |
|------|------|
| **Standard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Data on /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **China network** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Recommended) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

After install visit: `http://<your-server-ip>:3000`

## Volume Backups

Official Dokploy only supports database backups. This fork adds **Volume Backups**, enabling scheduled backup and restore of Docker volumes and bind mounts for any service (applications, Compose, databases).

**Entry**: Go to any app/service detail page -> `Volume Backups` tab

**Capabilities**:
- Scheduled auto-backup to S3 etc. via cron
- Supports Docker Named Volumes, Bind Mounts, backup all mounts at once
- Keep latest N backups, auto-cleanup old ones
- Optional container stop before backup for data consistency
- Restore from backups

## AI Assistant Panel

**Entry**: Login to Dashboard -> Click bot button in bottom-right corner

**Enable**: `Dashboard -> Settings -> AI` (`/dashboard/settings/ai`) -> Add AI Provider (OpenAI / Anthropic / Gemini / Ollama etc.)

**Capabilities**:
- Chat / Agent two modes
- Tool call approval: can interrupt streaming and cancel backend run
- MCP Servers: manage in panel, callable in conversations

### pgvector dependency

To enable Embedding/vector search, PostgreSQL needs pgvector. If dokploy-postgres is still postgres:16, upgrade:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## License

Based on upstream Dokploy (Apache-2.0), see [LICENSE.MD](../../LICENSE.MD).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md).
