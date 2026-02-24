<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>സഹായം, ഫീഡ്ബാക്ക്, ചർച്ചകൾ എന്നിവയ്ക്കായി ഞങ്ങളുടെ Discord-ൽ ചേരൂ!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

ഔദ്യോഗിക [Dokploy](https://github.com/Dokploy/dokploy) അടിസ്ഥാനമാക്കിയുള്ള കമ്മ്യൂണിറ്റി മെച്ചപ്പെടുത്തിയ പതിപ്പ്:

- **i18n** — 20+ ഭാഷകളുടെ പിന്തുണ
- **AI അസിസ്റ്റന്റ് പാനൽ** — Chat / Agent, ടൂൾ കോൾ അംഗീകാരം, MCP Server
- **വോളിയം ബാക്കപ്പുകൾ** — Docker വോളിയം/bind mount ബാക്കപ്പുകൾ ബാഹ്യ സ്റ്റോറേജിലേക്ക് ഷെഡ്യൂൾ ചെയ്യൽ, റിസ്റ്റോർ ചെയ്യലും

> ഔദ്യോഗിക ഡോക്യുമെന്റേഷൻ: [docs.dokploy.com](https://docs.dokploy.com)

---

**ഭാഷകൾ**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[കൂടുതൽ...](./)

---

## ഉള്ളടക്ക പട്ടിക

- [വേഗത്തിൽ ആരംഭിക്കുക](#വേഗത്തിൽ-ആരംഭിക്കുക)
- [വോളിയം ബാക്കപ്പുകൾ](#വോളിയം-ബാക്കപ്പുകൾ)
- [AI അസിസ്റ്റന്റ് പാനൽ](#ai-അസിസ്റ്റന്റ്-പാനൽ)
- [ലൈസൻസ്](#ലൈസൻസ്)

## വേഗത്തിൽ ആരംഭിക്കുക

> ആവശ്യകതകൾ: root അനുമതികൾ, 80/443/3000 പോർട്ടുകൾ ഒഴിഞ്ഞിരിക്കണം, Docker Swarm

| സാഹചര്യം | കമാൻഡ് |
|------|------|
| **സ്റ്റാൻഡേർഡ്** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **ഡാറ്റ /data-ൽ** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **ചൈന നെറ്റ്വർക്ക്** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **ചൈന + /data** (ശുപാർശ ചെയ്യുന്നു) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

ഇൻസ്റ്റാൾ ചെയ്ത ശേഷം സന്ദർശിക്കുക: `http://<your-server-ip>:3000`

## വോളിയം ബാക്കപ്പുകൾ

ഔദ്യോഗിക Dokploy ഡാറ്റാബേസ് ബാക്കപ്പുകൾ മാത്രമേ പിന്തുണയ്ക്കുന്നുള്ളൂ. ഈ fork ഏതൊരു സേവനത്തിനും (ആപ്ലിക്കേഷനുകൾ, Compose, ഡാറ്റാബേസുകൾ) Docker വോളിയങ്ങളുടെയും bind mount-കളുടെയും ഷെഡ്യൂൾ ചെയ്ത ബാക്കപ്പും റിസ്റ്റോറും പ്രാപ്തമാക്കുന്ന **വോളിയം ബാക്കപ്പുകൾ** ചേർക്കുന്നു.

**പ്രവേശനം**: ഏതെങ്കിലും ആപ്പ്/സേവന വിശദാംശ പേജിലേക്ക് പോകുക -> `വോളിയം ബാക്കപ്പുകൾ` ടാബ്

**കഴിവുകൾ**:
- Cron വഴി S3 തുടങ്ങിയവയിലേക്ക് ഷെഡ്യൂൾ ചെയ്ത ഓട്ടോ ബാക്കപ്പ്
- Docker Named Volumes, Bind Mounts പിന്തുണ, എല്ലാ mount-കളും ഒരുമിച്ച് ബാക്കപ്പ് ചെയ്യൽ
- അവസാന N ബാക്കപ്പുകൾ സൂക്ഷിക്കുക, പഴയവ ഓട്ടോമാറ്റിക്കായി വൃത്തിയാക്കൽ
- ഡാറ്റ കൺസിസ്റ്റൻസിക്കായി ബാക്കപ്പിന് മുമ്പ് കണ്ടെയ്നർ നിർത്താനുള്ള ഓപ്ഷൻ
- ബാക്കപ്പുകളിൽ നിന്ന് റിസ്റ്റോർ ചെയ്യൽ

## AI അസിസ്റ്റന്റ് പാനൽ

**പ്രവേശനം**: ഡാഷ്‌ബോർഡിലേക്ക് ലോഗിൻ ചെയ്യുക -> താഴെ വലത് കോണിലെ ബോട്ട് ബട്ടൺ ക്ലിക്ക് ചെയ്യുക

**പ്രവർത്തനക്ഷമമാക്കുക**: `ഡാഷ്‌ബോർഡ് -> ക്രമീകരണങ്ങൾ -> AI` (`/dashboard/settings/ai`) -> AI പ്രൊവൈഡർ ചേർക്കുക (OpenAI / Anthropic / Gemini / Ollama തുടങ്ങിയവ)

**കഴിവുകൾ**:
- Chat / Agent രണ്ട് മോഡുകൾ
- ടൂൾ കോൾ അംഗീകാരം: സ്ട്രീമിംഗ് തടസ്സപ്പെടുത്തി ബാക്കെൻഡ് റൺ റദ്ദാക്കാൻ കഴിയും
- MCP സെർവറുകൾ: പാനലിൽ മാനേജ് ചെയ്യുക, സംഭാഷണങ്ങളിൽ വിളിക്കാവുന്നത്

### pgvector ആശ്രിതത്വം

Embedding/വെക്റ്റർ സെർച്ച് പ്രവർത്തനക്ഷമമാക്കാൻ PostgreSQL-ന് pgvector ആവശ്യമാണ്. dokploy-postgres ഇപ്പോഴും postgres:16 ആണെങ്കിൽ, അപ്ഗ്രേഡ് ചെയ്യുക:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## ലൈസൻസ്

Dokploy upstream (Apache-2.0) അടിസ്ഥാനമാക്കി, കാണുക [LICENSE.MD](../../LICENSE.MD).

## സംഭാവന

കാണുക [CONTRIBUTING.md](../../CONTRIBUTING.md).
