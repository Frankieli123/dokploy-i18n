<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Dołącz do naszego Discorda, aby uzyskać pomoc, opinie i dyskusje!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Wersja rozszerzona przez społeczność na podstawie oficjalnego [Dokploy](https://github.com/Dokploy/dokploy), z:

- **i18n** — Obsługa 20+ języków
- **Panel Asystenta AI** — Chat / Agent, zatwierdzanie wywołań narzędzi, MCP Server
- **Kopie zapasowe woluminów** — Planowanie kopii zapasowych woluminów Docker/bind mount do zewnętrznego magazynu, z przywracaniem

> Oficjalna dokumentacja: [docs.dokploy.com](https://docs.dokploy.com)

---

**Języki**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Więcej...](./)

---

## Spis treści

- [Szybki Start](#szybki-start)
- [Kopie zapasowe woluminów](#kopie-zapasowe-woluminow)
- [Panel Asystenta AI](#panel-asystenta-ai)
- [Licencja](#licencja)

## Szybki Start

> Wymagania: uprawnienia root, porty 80/443/3000 wolne, Docker Swarm

| Scenariusz | Komenda |
|------|------|
| **Standardowy** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Dane na /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Sieć Chińska** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Chiny + /data** (Zalecane) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Po instalacji odwiedź: `http://<your-server-ip>:3000`

## Kopie zapasowe woluminów

Oficjalny Dokploy obsługuje tylko kopie zapasowe baz danych. Ten fork dodaje **Kopie zapasowe woluminów**, umożliwiając planowanie kopii zapasowych i przywracanie woluminów Docker i bind mounts dla dowolnej usługi (aplikacje, Compose, bazy danych).

**Wejście**: Przejdź do strony szczegółów dowolnej aplikacji/usługi -> zakładka `Kopie zapasowe woluminów`

**Możliwości**:
- Zaplanowana automatyczna kopia zapasowa do S3 itp. przez cron
- Obsługa Docker Named Volumes, Bind Mounts, kopia wszystkich montowań naraz
- Zachowaj ostatnie N kopii zapasowych, automatyczne czyszczenie starych
- Opcjonalne zatrzymanie kontenera przed kopią zapasową dla spójności danych
- Przywracanie z kopii zapasowych

## Panel Asystenta AI

**Wejście**: Zaloguj się do Pulpitu -> Kliknij przycisk bota w prawym dolnym rogu

**Włącz**: `Pulpit -> Ustawienia -> AI` (`/dashboard/settings/ai`) -> Dodaj dostawcę AI (OpenAI / Anthropic / Gemini / Ollama itp.)

**Możliwości**:
- Chat / Agent dwa tryby
- Zatwierdzanie wywołań narzędzi: można przerwać strumieniowanie i anulować uruchomienie backendu
- MCP Servers: zarządzanie w panelu, wywoływalne w rozmowach

### Zależność pgvector

Aby włączyć Embedding/wyszukiwanie wektorowe, PostgreSQL potrzebuje pgvector. Jeśli dokploy-postgres to nadal postgres:16, zaktualizuj:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licencja

Na podstawie Dokploy upstream (Apache-2.0), zobacz [LICENSE.MD](../../LICENSE.MD).

## Współtworzenie

Zobacz [CONTRIBUTING.md](../../CONTRIBUTING.md).
