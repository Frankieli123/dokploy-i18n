<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Kömək, rəy və müzakirə üçün Discord-umuza qoşulun!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Rəsmi [Dokploy](https://github.com/Dokploy/dokploy) bazasında cəmiyyət tərəfindən inkişaf etdirilmiş versiya:

- **i18n** — 20+ dil dəstəyi
- **AI Assistenti Paneli** — Chat / Agent, əlaqətləmə çağırışının təsdiqi, MCP Server
- **Həcmlərin ehtiyatları** — Docker həcmə/bind mount ehtiyatlarının xarici yaddaşa planlaşdırılması, bərpa ilə

> Rəsmi dokumentasiya: [docs.dokploy.com](https://docs.dokploy.com)

---

**Dillər**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Daha çox...](./)

---

## Mündərəcat

- [Sürətli Başlanğıc](#sürətli-başlanğıc)
- [Həcmlərin ehtiyatları](#həcmlərin-ehtiyatları)
- [AI Assistenti Paneli](#ai-assistenti-paneli)
- [Lisenziya](#lisenziya)

## Sürətli Başlanğıc

> Tələblər: root hüquqları, 80/443/3000 portları boş, Docker Swarm

| Ssenario | Əmr |
|------|------|
| **Standart** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Data /data-da** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Çin şəbəkəsi** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Çin + /data** (Tövsiyə olunur) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Quraşdırmadan sonra ziyarət edin: `http://<your-server-ip>:3000`

## Həcmlərin ehtiyatları

Rəsmi Dokploy yalnız məlumat bazası ehtiyatlarını dəstəkləyir. Bu fork, hər hansı bir xidmət (tətbiqlər, Compose, məlumat bazaları) üçün Docker həcmlərinin və bind mount'ların planlaşdırılmış ehtiyatını və bərpasını təmin edən **Həcmlərin ehtiyatları** əlavə edir.

**Giriş**: Hər hansı bir tətbiq/xidmət detallar səhifəsinə gedin -> `Həcmlərin ehtiyatları` tabı

**İmkanlar**:
- Cron vasitəsi ilə S3 və s.-ya planlaşdırılmış avtomatik ehtiyat
- Docker Named Volumes, Bind Mounts dəstəyi, bütün mount'ları bir dəfə ehtiyat et
- Son N ehtiyatı saxla, köhnə olanları avtomatik təmizlə
- Məlumat üzərliyi üçün ehtiyatdan əvvəl konteyneri dayandırmaq seçimi
- Ehtiyatlardan bərpa

## AI Assistenti Paneli

**Giriş**: İdarə panelinə daxil ol -> sağ alt küncdəki bot düyməsini kliklə

**Aktivləşdir**: `Dashboard -> Parametrlər -> AI` (`/dashboard/settings/ai`) -> AI Provayderi əlavə et (OpenAI / Anthropic / Gemini / Ollama və s.)

**İmkanlar**:
- Chat / Agent iki mod
- Əlaqətləmə çağırışının təsdiqi: axını kəsə və backend işini ləğv edə bilər
- MCP Serverlər: paneldə idarə et, söhbətlərdə çağırıla bilər

### pgvector asılılığı

Embedding/vektor axtarışını aktivləşdirmək üçün PostgreSQL pgvectora ehtiyac duyur. Əgər dokploy-postgres hələ də postgres:16-dırsa, yüksəldin:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Lisenziya

Dokploy upstream (Apache-2.0) bazasında, bax [LICENSE.MD](../../LICENSE.MD).

## Töhfə Vermək

Bax [CONTRIBUTING.md](../../CONTRIBUTING.md).
