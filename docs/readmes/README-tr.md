<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Yardım, geri bildirim ve tartışmalar için Discord sunucumuza katılın!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Resmi [Dokploy](https://github.com/Dokploy/dokploy) tabanlı topluluk geliştirilmiş sürüm:

- **i18n** — 20+ dil desteği
- **AI Asistan Paneli** — Chat / Agent, araç çağrısı onayı, MCP Server
- **Birim Yedekleri** — Docker birimi/bind mount yedeklerini dış depolama alanına zamanla, geri yükleme desteği

> Resmi dokümantasyon: [docs.dokploy.com](https://docs.dokploy.com)

---

**Diller**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Daha fazla...](./)

---

## İçerik

- [Hızlı Başlangıç](#hızlı-başlangıç)
- [Birim Yedekleri](#birim-yedekleri)
- [AI Asistan Paneli](#ai-asistan-paneli)
- [Lisans](#lisans)

## Hızlı Başlangıç

> Gereksinimler: root yetkisi, 80/443/3000 portları boş, Docker Swarm

| Senaryo | Komut |
|------|------|
| **Standart** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Veri /data'da** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Çin ağı** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Çin + /data** (Önerilen) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Kurulumdan sonra ziyaret et: `http://<your-server-ip>:3000`

## Birim Yedekleri

Resmi Dokploy sadece veritabanı yedeklerini destekler. Bu fork, herhangi bir hizmet (uygulamalar, Compose, veritabanları) için Docker birimleri ve bind mount'ların zamanlanmış yedekleme ve geri yükleme imkanı sağlayan **Birim Yedekleri** ekler.

**Giriş**: Herhangi bir uygulama/hizmet detay sayfasına git -> `Birim yedekleri` sekmesi

**Yetenekler**:
- Cron ile S3 vb.'ye zamanlanmış otomatik yedekleme
- Docker Named Volumes, Bind Mounts desteği, tüm mount'ları tek seferde yedekle
- Son N yedeği sakla, eskileri otomatik temizle
- Veri tutarlılığı için yedekleme öncesi konteyner durdurma seçeneği
- Yedeklerden geri yükleme

## AI Asistan Paneli

**Giriş**: Gösterge paneline giriş yap -> Sağ alt köşedeki bot düğmesine tıkla

**Etkinleştir**: `Gösterge paneli -> Ayarlar -> AI` (`/dashboard/settings/ai`) -> AI Sağlayıcı ekle (OpenAI / Anthropic / Gemini / Ollama vb.)

**Yetenekler**:
- Chat / Agent iki mod
- Araç çağrısı onayı: akışı kesebilir ve backend çalışmasını iptal edebilir
- MCP Serverlar: panelde yönet, konuşmalarda çağrılabilir

### pgvector bağımlılığı

Embedding/vektör aramayı etkinleştirmek için PostgreSQL'in pgvector'a ihtiyacı var. dokploy-postgres hala postgres:16 ise, yükselt:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Lisans

Upstream Dokploy (Apache-2.0) tabanlı, bkz. [LICENSE.MD](../../LICENSE.MD).

## Katkıda Bulunma

Bkz. [CONTRIBUTING.md](../../CONTRIBUTING.md).
