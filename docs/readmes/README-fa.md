<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>به دیسکورد ما بپیوندید تا کمک، بازخورد و بحث دریافت کنید!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

نسخه بهبود یافته توسط جامعه بر اساس [Dokploy](https://github.com/Dokploy/dokploy) رسمی، با:

- **i18n** — پشتیبانی از 20+ زبان
- **پنل دستیار هوش مصنوعی** — Chat / Agent، تایید فراخوانی ابزار، MCP Server
- **پشتیبان‌گیری‌های ولوم** — زمانبندی پشتیبان‌گیری ولوم‌های Docker/bind mount به ذخیره‌سازی خارجی، با بازیابی

> مستندات رسمی: [docs.dokploy.com](https://docs.dokploy.com)

---

**زبان‌ها**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[بیشتر...](./)

---

## فهرست

- [شروع سریع](#شروع-سریع)
- [پشتیبان‌گیری‌های ولوم](#پشتیبان‌گیریهای-ولوم)
- [پنل دستیار هوش مصنوعی](#پنل-دستیار-هوش-مصنوعی)
- [مجوز](#مجوز)

## شروع سریع

> نیازمندی‌ها: دسترسی root، پورت‌های 80/443/3000 آزاد، Docker Swarm

| سناریو | دستور |
|------|------|
| **استاندارد** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **داده در /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **شبکه چین** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **چین + /data** (پیشنهادی) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

بعد از نصب بازدید کنید: `http://<your-server-ip>:3000`

## پشتیبان‌گیری‌های ولوم

Dokploy رسمی فقط از پشتیبان‌گیری پایگاه داده پشتیبانی می‌کند. این fork **پشتیبان‌گیری‌های ولوم** را اضافه می‌کند که امکان پشتیبان‌گیری زمانبندی شده و بازیابی ولوم‌های Docker و bind mount را برای هر سرویسی (برنامه‌ها، Compose، پایگاه‌های داده) فراهم می‌کند.

**ورودی**: به صفحه جزئیات هر برنامه/سرویس بروید -> تب `پشتیبان‌گیری‌های ولوم`

**قابلیت‌ها**:
- پشتیبان‌گیری خودکار زمانبندی شده به S3 و غیره از طریق cron
- پشتیبانی از Docker Named Volumes، Bind Mounts، پشتیبان‌گیری همه mountها یکجا
- نگهداری N پشتیبان اخیر، پاکسازی خودکار قدیمی‌ها
- توقف اختیاری کانتینر قبل از پشتیبان‌گیری برای یکپارچگی داده
- بازیابی از پشتیبان‌ها

## پنل دستیار هوش مصنوعی

**ورودی**: به داشبورد وارد شوید -> دکمه ربات در گوشه پایین سمت راست را کلیک کنید

**فعال‌سازی**: `داشبورد → تنظیمات → هوش مصنوعی` (`/dashboard/settings/ai`) -> افزودن ارائه‌دهنده هوش مصنوعی (OpenAI / Anthropic / Gemini / Ollama و غیره)

**قابلیت‌ها**:
- Chat / Agent دو حالت
- تایید فراخوانی ابزار: می‌تواند استریم را قطع و اجرای backend را لغو کند
- MCP Serverها: مدیریت در پنل، قابل فراخوانی در مکالمات

### وابستگی pgvector

برای فعال‌سازی Embedding/جستجوی برداری، PostgreSQL به pgvector نیاز دارد. اگر dokploy-postgres هنوز postgres:16 است، ارتقا دهید:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## مجوز

بر اساس Dokploy upstream (Apache-2.0)، ببینید [LICENSE.MD](../../LICENSE.MD).

## مشارکت

ببینید [CONTRIBUTING.md](../../CONTRIBUTING.md).
