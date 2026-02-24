<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Tritt unserem Discord bei, um Hilfe, Feedback und Diskussionen zu erhalten!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Community-erweiterte Version basierend auf dem offiziellen [Dokploy](https://github.com/Dokploy/dokploy), mit:

- **i18n** — Unterstützung für 20+ Sprachen
- **KI-Assistent-Panel** — Chat / Agent, Werkzeugaufruf-Genehmigung, MCP Server
- **Volume-Backups** — Geplante Docker-Volume/Bind-Mount-Backups auf externen Speicher, mit Wiederherstellung

> Offizielle Dokumentation: [docs.dokploy.com](https://docs.dokploy.com)

---

**Sprachen**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Mehr...](./)

---

## Inhaltsverzeichnis

- [Schnellstart](#schnellstart)
- [Volume-Backups](#volume-backups)
- [KI-Assistent-Panel](#ki-assistent-panel)
- [Lizenz](#lizenz)

## Schnellstart

> Voraussetzungen: Root-Rechte, Ports 80/443/3000 frei, Docker Swarm

| Szenario | Befehl |
|------|------|
| **Standard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Daten auf /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **China-Netzwerk** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Empfohlen) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Nach der Installation besuchen: `http://<your-server-ip>:3000`

## Volume-Backups

Das offizielle Dokploy unterstützt nur Datenbank-Backups. Dieser Fork fügt **Volume-Backups** hinzu, die geplante Backups und Wiederherstellungen von Docker-Volumes und Bind-Mounts für jeden Service (Anwendungen, Compose, Datenbanken) ermöglichen.

**Einstieg**: Gehen Sie zu einer beliebigen App/Service-Detailseite -> `Volume-Backups` Tab

**Funktionen**:
- Geplantes Auto-Backup zu S3 etc. via Cron
- Unterstützt Docker Named Volumes, Bind Mounts, Backup aller Mounts auf einmal
- Behalte die letzten N Backups, automatische Bereinigung alter Backups
- Optionales Stoppen des Containers vor dem Backup für Datenkonsistenz
- Wiederherstellung aus Backups

## KI-Assistent-Panel

**Einstieg**: Im Dashboard einloggen -> Klicken Sie auf den Bot-Button in der unteren rechten Ecke

**Aktivieren**: `Dashboard -> Einstellungen -> AI` (`/dashboard/settings/ai`) -> AI-Provider hinzufügen (OpenAI / Anthropic / Gemini / Ollama etc.)

**Funktionen**:
- Chat / Agent zwei Modi
- Werkzeugaufruf-Genehmigung: Kann Streaming unterbrechen und Backend-Run abbrechen
- MCP Server: Im Panel verwalten, in Gesprächen aufrufbar

### pgvector-Abhängigkeit

Um Embedding/Vektorsuche zu aktivieren, benötigt PostgreSQL pgvector. Wenn dokploy-postgres noch postgres:16 ist, upgraden:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Lizenz

Basiert auf Upstream Dokploy (Apache-2.0), siehe [LICENSE.MD](../../LICENSE.MD).

## Beitragen

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md).
