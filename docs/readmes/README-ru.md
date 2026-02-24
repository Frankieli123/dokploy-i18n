<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Присоединяйтесь к нашему Discord для помощи, отзывов и обсуждений!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Улучшенная версия от сообщества на основе официального [Dokploy](https://github.com/Dokploy/dokploy), с:

- **i18n** — Поддержка 20+ языков
- **Панель ИИ-ассистента** — Chat / Agent, одобрение вызова инструментов, MCP Server
- **Резервные копии томов** — Планирование резервного копирования Docker томов/bind mount на внешнее хранилище с восстановлением

> Официальная документация: [docs.dokploy.com](https://docs.dokploy.com)

---

**Языки**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Ещё...](./)

---

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Резервные копии томов](#резервные-копии-томов)
- [Панель ИИ-ассистента](#панель-ии-ассистента)
- [Лицензия](#лицензия)

## Быстрый старт

> Требования: права root, порты 80/443/3000 свободны, Docker Swarm

| Сценарий | Команда |
|------|------|
| **Стандарт** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Данные на /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Сеть Китая** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Китай + /data** (Рекомендуется) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

После установки посетите: `http://<your-server-ip>:3000`

## Резервные копии томов

Официальный Dokploy поддерживает только резервное копирование баз данных. Этот fork добавляет **Резервные копии томов**, позволяя планировать резервное копирование и восстановление Docker томов и bind mount для любого сервиса (приложения, Compose, базы данных).

**Вход**: Перейдите на страницу деталей любого приложения/сервиса -> вкладка `Резервные копии томов`

**Возможности**:
- Планируемое автосохранение на S3 и др. через cron
- Поддержка Docker Named Volumes, Bind Mounts, резервное копирование всех томов сразу
- Хранение последних N резервных копий, автоочистка старых
- Опциональная остановка контейнера перед резервным копированием для согласованности данных
- Восстановление из резервных копий

## Панель ИИ-ассистента

**Вход**: Войдите в Панель управления -> Нажмите кнопку бота в правом нижнем углу

**Включить**: `Панель управления -> Настройки -> AI` (`/dashboard/settings/ai`) -> Добавить AI провайдера (OpenAI / Anthropic / Gemini / Ollama и др.)

**Возможности**:
- Chat / Agent два режима
- Одобрение вызова инструментов: можно прервать поток и отменить выполнение на бэкенде
- MCP Server: управление в панели, вызов в разговорах

### Зависимость pgvector

Для включения Embedding/векторного поиска PostgreSQL требуется pgvector. Если dokploy-postgres всё ещё postgres:16, обновите:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Лицензия

Основано на Dokploy (Apache-2.0), см. [LICENSE.MD](../../LICENSE.MD).

## Участие

См. [CONTRIBUTING.md](../../CONTRIBUTING.md).
