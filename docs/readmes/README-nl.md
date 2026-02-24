<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Word lid van onze Discord voor hulp, feedback en discussies!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Community verbeterde versie gebaseerd op de officiële [Dokploy](https://github.com/Dokploy/dokploy), met:

- **i18n** — Ondersteuning voor 20+ talen
- **AI Assistent Paneel** — Chat / Agent, tool call goedkeuring, MCP Server
- **Volume Backups** — Geplande Docker volume/bind mount backups naar externe opslag, met herstel

> Officiële documentatie: [docs.dokploy.com](https://docs.dokploy.com)

---

**Talen**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Meer...](./)

---

## Inhoudsopgave

- [Snel Starten](#snel-starten)
- [Volume Backups](#volume-backups)
- [AI Assistent Paneel](#ai-assistent-paneel)
- [Licentie](#licentie)

## Snel Starten

> Vereisten: root rechten, poorten 80/443/3000 vrij, Docker Swarm

| Scenario | Commando |
|------|------|
| **Standaard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Data op /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **China netwerk** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Aanbevolen) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Na installatie bezoek: `http://<your-server-ip>:3000`

## Volume Backups

De officiële Dokploy ondersteunt alleen database backups. Deze fork voegt **Volume Backups** toe, waardoor geplande backups en herstel van Docker volumes en bind mounts voor elke service (applicaties, Compose, databases) mogelijk wordt.

**Ingang**: Ga naar een app/service detailpagina -> `Volume Backups` tab

**Mogelijkheden**:
- Geplande auto-backup naar S3 etc. via cron
- Ondersteunt Docker Named Volumes, Bind Mounts, backup van alle mounts tegelijk
- Houd de laatste N backups, automatische opruiming van oude
- Optionele container stop voor backup voor data consistentie
- Herstel vanaf backups

## AI Assistent Paneel

**Ingang**: Log in op Dashboard -> Klik op de bot-knop in de rechterbenedenhoek

**Inschakelen**: `Dashboard -> Instellingen -> AI` (`/dashboard/settings/ai`) -> Voeg AI Provider toe (OpenAI / Anthropic / Gemini / Ollama etc.)

**Mogelijkheden**:
- Chat / Agent twee modi
- Tool call goedkeuring: kan streaming onderbreken en backend run annuleren
- MCP Servers: beheer in paneel, aanroepbaar in gesprekken

### pgvector afhankelijkheid

Om Embedding/vector zoekopdrachten in te schakelen, heeft PostgreSQL pgvector nodig. Als dokploy-postgres nog steeds postgres:16 is, upgrade:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licentie

Gebaseerd op upstream Dokploy (Apache-2.0), zie [LICENSE.MD](../../LICENSE.MD).

## Bijdragen

Zie [CONTRIBUTING.md](../../CONTRIBUTING.md).
