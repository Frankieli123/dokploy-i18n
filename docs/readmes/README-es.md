<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Únete a nuestro Discord para obtener ayuda, comentarios y discusiones!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Versión mejorada por la comunidad basada en el [Dokploy](https://github.com/Dokploy/dokploy) oficial, con:

- **i18n** — Soporte para 20+ idiomas
- **Panel de Asistente IA** — Chat / Agent, aprobación de llamadas de herramientas, MCP Server
- **Copias de Seguridad de Volúmenes** — Programación de copias de seguridad de volúmenes Docker/bind mount en almacenamiento externo, con restauración

> Documentación oficial: [docs.dokploy.com](https://docs.dokploy.com)

---

**Idiomas**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Más...](./)

---

## Tabla de Contenidos

- [Inicio Rápido](#inicio-rápido)
- [Copias de Seguridad de Volúmenes](#copias-de-seguridad-de-volúmenes)
- [Panel de Asistente IA](#panel-de-asistente-ia)
- [Licencia](#licencia)

## Inicio Rápido

> Requisitos: privilegios root, puertos 80/443/3000 libres, Docker Swarm

| Escenario | Comando |
|------|------|
| **Estándar** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Datos en /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Red de China** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Recomendado) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Después de instalar visita: `http://<your-server-ip>:3000`

## Copias de Seguridad de Volúmenes

El Dokploy oficial solo admite copias de seguridad de bases de datos. Este fork añade **Copias de Seguridad de Volúmenes**, permitiendo copias de seguridad programadas y restauración de volúmenes Docker y bind mounts para cualquier servicio (aplicaciones, Compose, bases de datos).

**Entrada**: Ve a cualquier página de detalles de aplicación/servicio -> pestaña `Copias de Seguridad de Volúmenes`

**Capacidades**:
- Copia de seguridad automática programada a S3 etc. via cron
- Soporta Docker Named Volumes, Bind Mounts, copia de seguridad de todos los montajes a la vez
- Mantener las últimas N copias de seguridad, limpieza automática de antiguas
- Parada opcional del contenedor antes de la copia de seguridad para consistencia de datos
- Restauración desde copias de seguridad

## Panel de Asistente IA

**Entrada**: Inicia sesión en el Panel -> Haz clic en el botón del bot en la esquina inferior derecha

**Habilitar**: `Panel -> Ajustes -> AI` (`/dashboard/settings/ai`) -> Añadir proveedor de IA (OpenAI / Anthropic / Gemini / Ollama etc.)

**Capacidades**:
- Chat / Agent dos modos
- Aprobación de llamadas de herramientas: puede interrumpir el streaming y cancelar la ejecución del backend
- MCP Servers: gestionar en el panel, invocables en conversaciones

### Dependencia pgvector

Para habilitar Embedding/búsqueda vectorial, PostgreSQL necesita pgvector. Si dokploy-postgres todavía es postgres:16, actualiza:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Licencia

Basado en Dokploy upstream (Apache-2.0), ver [LICENSE.MD](../../LICENSE.MD).

## Contribuir

Ver [CONTRIBUTING.md](../../CONTRIBUTING.md).
