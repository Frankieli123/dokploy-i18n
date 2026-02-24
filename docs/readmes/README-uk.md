<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Приєднуйтесь до нашого Discord для отримання допомоги, відгуків та обговорень!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Покращена версія від спільноти на основі офіційного [Dokploy](https://github.com/Dokploy/dokploy), з:

- **i18n** — Підтримка 20+ мов
- **Панель ІІ-асистента** — Chat / Agent, схвалення виклику інструментів, MCP Server
- **Резервні копії томів** — Планування резервного копіювання Docker томів/bind mount на зовнішнє сховище з відновленням

> Офіційна документація: [docs.dokploy.com](https://docs.dokploy.com)

---

**Мови**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Більше...](./)

---

## Зміст

- [Швидкий старт](#швидкий-старт)
- [Резервні копії томів](#резервні-копії-томів)
- [Панель ІІ-асистента](#панель-ії-асистента)
- [Ліцензія](#ліцензія)

## Швидкий старт

> Вимоги: права root, порти 80/443/3000 вільні, Docker Swarm

| Сценарій | Команда |
|------|------|
| **Стандарт** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Дані на /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Мережа Китаю** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Китай + /data** (Рекомендовано) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Після встановлення відвідайте: `http://<your-server-ip>:3000`

## Резервні копії томів

Офіційний Dokploy підтримує лише резервне копіювання баз даних. Цей fork додає **Резервні копії томів**, дозволяючи планувати резервне копіювання та відновлення Docker томів і bind mount для будь-якого сервісу (додатки, Compose, бази даних).

**Вхід**: Перейдіть на сторінку деталей будь-якого додатку/сервісу -> вкладка `Резервні копії томів`

**Можливості**:
- Плановане автозбереження на S3 та ін. через cron
- Підтримка Docker Named Volumes, Bind Mounts, резервне копіювання всіх томів разом
- Збереження останніх N резервних копій, автоочищення старих
- Опціональна зупинка контейнера перед резервним копіюванням для узгодженості даних
- Відновлення з резервних копій

## Панель ІІ-асистента

**Вхід**: Увійдіть в Панель -> Натисніть кнопку бота в правому нижньому куті

**Увімкнути**: `Панель -> Налаштування -> AI` (`/dashboard/settings/ai`) -> Додати AI провайдера (OpenAI / Anthropic / Gemini / Ollama та ін.)

**Можливості**:
- Chat / Agent два режими
- Схвалення виклику інструментів: можна перервати потік та скасувати виконання на бекенді
- MCP Servers: керування в панелі, виклик у розмовах

### Залежність pgvector

Для ввімкнення Embedding/векторного пошуку PostgreSQL потребує pgvector. Якщо dokploy-postgres все ще postgres:16, оновіть:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Ліцензія

На основі Dokploy upstream (Apache-2.0), див. [LICENSE.MD](../../LICENSE.MD).

## Участь

Див. [CONTRIBUTING.md](../../CONTRIBUTING.md).
