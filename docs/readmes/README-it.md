<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Unisciti al nostro Discord per aiuto, feedback e discussioni!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Versione migliorata dalla community basata sul [Dokploy](https://github.com/Dokploy/dokploy) ufficiale, con:

- **i18n** — Supporto per 20+ lingue
- **Pannello Assistente IA** — Chat / Agent, approvazione chiamata strumenti, MCP Server
- **Backup Volume** — Pianificazione backup volumi Docker/bind mount su storage esterno, con ripristino

> Documentazione ufficiale: [docs.dokploy.com](https://docs.dokploy.com)

---

**Lingue**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Altro...](./)

---

## Indice

- [Avvio Rapido](#avvio-rapido)
- [Backup Volume](#backup-volume)
- [Pannello Assistente IA](#pannello-assistente-ia)
- [Licenza](#licenza)

## Avvio Rapido

> Requisiti: privilegi root, porte 80/443/3000 libere, Docker Swarm

| Scenario | Comando |
|------|------|
| **Standard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Dati su /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Rete Cina** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Cina + /data** (Consigliato) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Dopo l'installazione visita: `http://<your-server-ip>:3000`

## Backup Volume

Il Dokploy ufficiale supporta solo i backup del database. Questo fork aggiunge **Backup Volume**, abilitando backup pianificati e ripristino di volumi Docker e bind mount per qualsiasi servizio (applicazioni, Compose, database).

**Accesso**: Vai a qualsiasi pagina dettagli app/servizio -> scheda `Backup Volume`

**Capacità**:
- Backup automatico pianificato su S3 ecc. via cron
- Supporta Docker Named Volumes, Bind Mounts, backup di tutti i mount insieme
- Mantieni gli ultimi N backup, pulizia automatica dei vecchi
- Arresto opzionale del container prima del backup per consistenza dei dati
- Ripristino dai backup

## Pannello Assistente IA

**Accesso**: Accedi alla Dashboard -> Clicca il pulsante bot nell'angolo in basso a destra

**Abilita**: `Dashboard -> Impostazioni -> AI` (`/dashboard/settings/ai`) -> Aggiungi provider AI (OpenAI / Anthropic / Gemini / Ollama ecc.)

**Capacità**:
- Chat / Agent due modalità
- Approvazione chiamata strumenti: può interrompere lo streaming e annullare l'esecuzione backend
- MCP Servers: gestisci nel pannello, richiamabili nelle conversazioni

### Dipendenza pgvector

Per abilitare Embedding/ricerca vettoriale, PostgreSQL necessita di pgvector. Se dokploy-postgres è ancora postgres:16, aggiorna:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licenza

Basato su Dokploy upstream (Apache-2.0), vedi [LICENSE.MD](../../LICENSE.MD).

## Contribuire

Vedi [CONTRIBUTING.md](../../CONTRIBUTING.md).
