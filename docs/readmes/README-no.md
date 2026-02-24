<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Bli med på vår Discord for hjelp, tilbakemeldinger og diskusjoner!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Community forbedret versjon basert på offisiell [Dokploy](https://github.com/Dokploy/dokploy), med:

- **i18n** — Støtte for 20+ språk
- **AI Assistent Panel** — Chat / Agent, verktøykall-godkjenning, MCP Server
- **Volum-sikkerhetskopier** — Planlagte Docker volum/bind mount sikkerhetskopier til ekstern lagring, med gjenoppretting

> Offisiell dokumentasjon: [docs.dokploy.com](https://docs.dokploy.com)

---

**Språk**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Mer...](./)

---

## Innholdsfortegnelse

- [Rask Start](#rask-start)
- [Volum-sikkerhetskopier](#volum-sikkerhetskopier)
- [AI Assistent Panel](#ai-assistent-panel)
- [Lisens](#lisens)

## Rask Start

> Krav: root rettigheter, porter 80/443/3000 ledige, Docker Swarm

| Scenario | Kommando |
|------|------|
| **Standard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Data på /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Kina nettverk** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Kina + /data** (Anbefalt) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Etter installasjon besøk: `http://<your-server-ip>:3000`

## Volum-sikkerhetskopier

Offisiell Dokploy støtter kun database-sikkerhetskopier. Denne fork legger til **Volum-sikkerhetskopier**, som muliggjør planlagte sikkerhetskopier og gjenoppretting av Docker volumer og bind mounts for enhver tjeneste (applikasjoner, Compose, databaser).

**Inngang**: Gå til en app/tjeneste detaljside -> `Volum-sikkerhetskopier` fane

**Egenskaper**:
- Planlagt auto-sikkerhetskopi til S3 etc. via cron
- Støtter Docker Named Volumes, Bind Mounts, sikkerhetskopi av alle mounts samtidig
- Behold de siste N sikkerhetskopiene, automatisk opprydding av gamle
- Valgfri container-stopp før sikkerhetskopi for datakonsistens
- Gjenoppretting fra sikkerhetskopier

## AI Assistent Panel

**Inngang**: Logg inn på Dashbord -> Klikk på bot-knappen i nedre høyre hjørne

**Aktiver**: `Dashbord -> Innstillinger -> AI` (`/dashboard/settings/ai`) -> Legg til AI-leverandør (OpenAI / Anthropic / Gemini / Ollama etc.)

**Egenskaper**:
- Chat / Agent to moduser
- Verktøykall-godkjenning: kan avbryte strømming og kansellere backend-kjøring
- MCP Servere: administrer i panelet, kan kalles i samtaler

### pgvector avhengighet

For å aktivere Embedding/vektorsøk, trenger PostgreSQL pgvector. Hvis dokploy-postgres fortsatt er postgres:16, oppgrader:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Lisens

Basert på oppstrøms Dokploy (Apache-2.0), se [LICENSE.MD](../../LICENSE.MD).

## Bidra

Se [CONTRIBUTING.md](../../CONTRIBUTING.md).
