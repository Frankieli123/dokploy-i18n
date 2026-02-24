<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Көмек, пікірлер және талқылау үшін біздің Discord-қа қосылыңыз!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Ресми [Dokploy](https://github.com/Dokploy/dokploy) негізінде қауымдастық жетілдірген нұсқа:

- **i18n** — 20+ тілді қолдау
- **Жасанды интеллект Ассистент Панелі** — Chat / Agent, құрал шақыруды бекіту, MCP Server
- **Том резервтік көшірмелері** — Docker томы/bind mount резервтік көшірмелерін сыртқы сақтауға жоспарлау, қалпына келтірумен

> Ресми құжаттама: [docs.dokploy.com](https://docs.dokploy.com)

---

**Тілдер**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Көбірек...](./)

---

## Мазмұны

- [Жылдам Бастау](#жылдам-бастау)
- [Том резервтік көшірмелері](#том-резервтік-көшірмелері)
- [Жасанды интеллект Ассистент Панелі](#жасанды-интеллект-ассистент-панелі)
- [Лицензия](#лицензия)

## Жылдам Бастау

> Талаптар: root құқықтары, 80/443/3000 порттары бос, Docker Swarm

| Сценарий | Команда |
|------|------|
| **Стандарт** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Деректер /data-да** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Қытай желісі** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Қытай + /data** (Ұсынылады) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Орнатудан кейін кіріңіз: `http://<your-server-ip>:3000`

## Том резервтік көшірмелері

Ресми Dokploy тек дерекқор резервтік көшірмелерін қолдайды. Бұл fork кез келген қызмет (қолданбалар, Compose, дерекқорлар) үшін Docker томдары мен bind mount резервтік көшірмелерін жоспарлау және қалпына келтіру мүмкіндігін беретін **Том резервтік көшірмелері** қосады.

**Кіру**: Кез келген қолданба/қызмет мәліметтер бетіне өтіңіз -> `Том резервтік көшірмелері` қойындысы

**Мүмкіндіктер**:
- Cron арқылы S3 және т.б. жоспарлы автоматты резервтік көшірме
- Docker Named Volumes, Bind Mounts қолдауы, барлық mount бірден резервтік көшірме
- Соңғы N резервтік көшірмені сақтау, ескілерін автотазалау
- Дерекқор тұтастығы үшін резервтік көшірме алдында контейнерді тоқтату мүмкіндігі
- Резервтік көшірмелерден қалпына келтіру

## Жасанды интеллект Ассистент Панелі

**Кіру**: Басқару панеліне кіріңіз -> оң жақ төменгі бұрыштағы бот түймесін басыңыз

**Қосу**: `Басқару панелі -> Баптаулар -> Жасанды интеллект` (`/dashboard/settings/ai`) -> ЖИ провайдерін қосу (OpenAI / Anthropic / Gemini / Ollama және т.б.)

**Мүмкіндіктер**:
- Chat / Agent екі режим
- Құрал шақыруды бекіту: ағынды үзіп, backend орындауды болдырмауға болады
- MCP Serverлер: панельде басқару, сөйлесулерде шақыруға болады

### pgvector тәуелділігі

Embedding/векторлық іздеуді қосу үшін PostgreSQL pgvector-ге мұқтаж. Егер dokploy-postgres әлі postgres:16 болса, жаңартыңыз:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Лицензия

Dokploy upstream (Apache-2.0) негізінде, қараңыз [LICENSE.MD](../../LICENSE.MD).

## Үлес Қосу

Қараңыз [CONTRIBUTING.md](../../CONTRIBUTING.md).
