<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Rejoignez notre Discord pour obtenir de l'aide, des commentaires et des discussions !</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Version communautaire améliorée basée sur le [Dokploy](https://github.com/Dokploy/dokploy) officiel, avec :

- **i18n** — Prise en charge de 20+ langues
- **Panneau Assistant IA** — Chat / Agent, approbation d'appel d'outil, Serveur MCP
- **Sauvegardes de volume** — Sauvegardes programmées de volumes Docker/bind mounts vers un stockage externe, avec restauration

> Documentation officielle : [docs.dokploy.com](https://docs.dokploy.com)

---

**Langues**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Plus…](./）

---

## Table des matières

- [Démarrage rapide](#démarrage-rapide)
- [Sauvegardes de volume](#sauvegardes-de-volume)
- [Panneau Assistant IA](#panneau-assistant-ia)
- [Licence](#licence)

## Démarrage rapide

> Prérequis : privilèges root, ports 80/443/3000 libres, Docker Swarm

| Scénario | Commande |
|------|------|
| **Standard** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Données sur /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Réseau Chine** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **Chine + /data** (Recommandé) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Après l'installation, visitez : `http://<your-server-ip>:3000`

## Sauvegardes de volume

Le Dokploy officiel ne prend en charge que les sauvegardes de bases de données. Ce fork ajoute les **Sauvegardes de volume**, permettant les sauvegardes programmées et la restauration des volumes Docker et bind mounts pour tout service (applications, Compose, bases de données).

**Accès** : Allez sur n'importe quelle page de détail d'application/service → onglet `Sauvegardes de volume`

**Capacités** :
- Sauvegarde automatique programmée vers S3 etc. via cron
- Prend en charge les Docker Named Volumes, Bind Mounts, sauvegarde de tous les montages à la fois
- Conserver les N dernières sauvegardes, nettoyage automatique des anciennes
- Arrêt optionnel du conteneur avant la sauvegarde pour la cohérence des données
- Restauration à partir des sauvegardes

## Panneau Assistant IA

**Accès** : Connectez-vous au Tableau de bord → Cliquez sur le bouton bot dans le coin inférieur droit

**Activer** : `Tableau de bord → Paramètres → IA` (`/dashboard/settings/ai`) → Ajouter un fournisseur IA (OpenAI / Anthropic / Gemini / Ollama etc.)

**Capacités** :
- Chat / Agent deux modes
- Approbation d'appel d'outil : peut interrompre le streaming et annuler l'exécution backend
- Serveurs MCP : gérer dans le panneau, appelables dans les conversations

### Dépendance pgvector

Pour activer Embedding/recherche vectorielle, PostgreSQL a besoin de pgvector. Si dokploy-postgres est encore postgres:16, mettez à niveau :

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licence

Basé sur le Dokploy amont (Apache-2.0), voir [LICENSE.MD](../../LICENSE.MD).

## Contribution

Voir [CONTRIBUTING.md](../../CONTRIBUTING.md).
