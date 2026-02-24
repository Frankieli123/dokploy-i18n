<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Bergabunglah dengan Discord kami untuk bantuan, umpan balik, dan diskusi!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

Versi yang ditingkatkan oleh komunitas berdasarkan [Dokploy](https://github.com/Dokploy/dokploy) resmi, dengan:

- **i18n** — Dukungan 20+ bahasa
- **Panel Asisten AI** — Chat / Agent, persetujuan pemanggilan alat, MCP Server
- **Cadangan Volume** — Penjadwalan cadangan volume Docker/bind mount ke penyimpanan eksternal, dengan pemulihan

> Dokumentasi resmi: [docs.dokploy.com](https://docs.dokploy.com)

---

**Bahasa**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[Lebih lanjut...](./)

---

## Daftar Isi

- [Memulai Cepat](#memulai-cepat)
- [Cadangan Volume](#cadangan-volume)
- [Panel Asisten AI](#panel-asisten-ai)
- [Lisensi](#lisensi)

## Memulai Cepat

> Persyaratan: hak root, port 80/443/3000 bebas, Docker Swarm

| Skenario | Perintah |
|------|------|
| **Standar** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **Data di /data** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **Jaringan China** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **China + /data** (Disarankan) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

Setelah instalasi kunjungi: `http://<your-server-ip>:3000`

## Cadangan Volume

Dokploy resmi hanya mendukung cadangan database. Fork ini menambahkan **Cadangan Volume**, memungkinkan cadangan terjadwal dan pemulihan volume Docker dan bind mount untuk layanan apa pun (aplikasi, Compose, database).

**Masuk**: Buka halaman detail aplikasi/layanan apa saja -> tab `Cadangan Volume`

**Kemampuan**:
- Cadangan otomatis terjadwal ke S3 dll. via cron
- Mendukung Docker Named Volumes, Bind Mounts, cadangkan semua mount sekaligus
- Simpan N cadangan terakhir, pembersihan otomatis yang lama
- Opsional hentikan container sebelum cadangan untuk konsistensi data
- Pemulihan dari cadangan

## Panel Asisten AI

**Masuk**: Login ke Dasbor -> Klik tombol bot di sudut kanan bawah

**Aktifkan**: `Dasbor -> Pengaturan -> AI` (`/dashboard/settings/ai`) -> Tambahkan Penyedia AI (OpenAI / Anthropic / Gemini / Ollama dll.)

**Kemampuan**:
- Chat / Agent dua mode
- Persetujuan pemanggilan alat: dapat menghentikan streaming dan membatalkan eksekusi backend
- MCP Servers: kelola di panel, dapat dipanggil dalam percakapan

### Ketergantungan pgvector

Untuk mengaktifkan Embedding/pencarian vektor, PostgreSQL membutuhkan pgvector. Jika dokploy-postgres masih postgres:16, tingkatkan:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## Lisensi

Berdasarkan Dokploy upstream (Apache-2.0), lihat [LICENSE.MD](../../LICENSE.MD).

## Berkontribusi

Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md).
