<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Junte-se ao nosso Discord para obter ajuda, feedback e discussões!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Versão aprimorada pela comunidade baseada no [Dokploy](https://github.com/Dokploy/dokploy) oficial, com:

- **i18n** — Suporte para 20+ idiomas
- **Painel do Assistente IA** — Chat / Agent, aprovação de chamada de ferramenta, MCP Server
- **Backups de Volume** — Agendamento de backups de volumes Docker/bind mount para armazenamento externo, com restauração

> Documentação oficial: [docs.dokploy.com](https://docs.dokploy.com)

---

**Idiomas**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Mais...](./)

---

## Sumário

- [Início Rápido](#início-rápido)
- [Backups de Volume](#backups-de-volume)
- [Painel do Assistente IA](#painel-do-assistente-ia)
- [Licença](#licença)

## Início Rápido

> Requisitos: privilégios root, portas 80/443/3000 livres, Docker Swarm

| Cenário | Comando |
|------|------|
| **Padrão** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Dados em /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Rede da China** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Recomendado) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Após instalar visite: `http://<your-server-ip>:3000`

## Backups de Volume

O Dokploy oficial só suporta backups de banco de dados. Este fork adiciona **Backups de Volume**, permitindo backups agendados e restauração de volumes Docker e bind mounts para qualquer serviço (aplicações, Compose, bancos de dados).

**Entrada**: Vá para qualquer página de detalhes de app/serviço -> aba `Backups de volume`

**Capacidades**:
- Backup automático agendado para S3 etc. via cron
- Suporta Docker Named Volumes, Bind Mounts, backup de todos os montes de uma vez
- Manter os últimos N backups, limpeza automática dos antigos
- Parada opcional do container antes do backup para consistência de dados
- Restauração a partir de backups

## Painel do Assistente IA

**Entrada**: Faça login no Painel -> Clique no botão do bot no canto inferior direito

**Habilitar**: `Painel -> Configurações -> AI` (`/dashboard/settings/ai`) -> Adicionar provedor de IA (OpenAI / Anthropic / Gemini / Ollama etc.)

**Capacidades**:
- Chat / Agent dois modos
- Aprovação de chamada de ferramenta: pode interromper o streaming e cancelar a execução backend
- MCP Servers: gerenciar no painel, chamáveis nas conversas

### Dependência pgvector

Para habilitar Embedding/pesquisa vetorial, o PostgreSQL precisa do pgvector. Se dokploy-postgres ainda é postgres:16, atualize:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licença

Baseado no Dokploy upstream (Apache-2.0), veja [LICENSE.MD](../../LICENSE.MD).

## Contribuindo

Veja [CONTRIBUTING.md](../../CONTRIBUTING.md).
