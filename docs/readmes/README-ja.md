<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Discordに参加して、ヘルプ、フィードバック、ディスカッションに参加しましょう！</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

公式[Dokploy](https://github.com/Dokploy/dokploy)をベースにしたコミュニティ拡張版：

- **i18n** — 20以上の言語に対応
- **AIアシスタントパネル** — チャット/エージェント、ツール呼び出し承認、MCPサーバー
- **ボリュームバックアップ** — Dockerボリューム/バインドマウントの外部ストレージへの定期バックアップ、復元対応

> 公式ドキュメント：[docs.dokploy.com](https://docs.dokploy.com)

---

**言語**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[もっと...](./)

---

## 目次

- [クイックスタート](#クイックスタート)
- [ボリュームバックアップ](#ボリュームバックアップ)
- [AIアシスタントパネル](#aiアシスタントパネル)
- [ライセンス](#ライセンス)

## クイックスタート

> 要件：root権限、ポート80/443/3000が空き、Docker Swarm

| シナリオ | コマンド |
|------|------|
| **標準** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **データを/dataに** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **中国ネットワーク** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **中国 + /data**（推奨） | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

インストール後：`http://<your-server-ip>:3000` にアクセス

## ボリュームバックアップ

公式Dokployはデータベースバックアップのみ対応しています。このforkは**ボリュームバックアップ**を追加し、あらゆるサービス（アプリケーション、Compose、データベース）のDockerボリュームとバインドマウントの定期バックアップと復元を可能にします。

**入口**：任意のアプリ/サービス詳細ページへ -> `ボリュームバックアップ`タブ

**機能**：
- CronによるS3などへの自動バックアップ
- Docker Named Volume、バインドマウント対応、全マウントの一括バックアップ
- 最新N個のバックアップを保持、古いものを自動削除
- データ整合性のためバックアップ前にコンテナ停止を選択可能
- バックアップからの復元

## AIアシスタントパネル

**入口**：ダッシュボードにログイン -> 右下のボットボタンをクリック

**有効化**：`ダッシュボード → 設定 → AI`（`/dashboard/settings/ai`）-> AIプロバイダーを追加（OpenAI / Anthropic / Gemini / Ollama等）

**機能**：
- チャット/エージェント2つのモード
- ツール呼び出し承認：ストリーミングを中断してバックエンドの実行をキャンセル可能
- MCPサーバー：パネル内で管理、会話で呼び出し可能

### pgvector依存関係

Embedding/ベクトル検索を有効にするには、PostgreSQLにpgvectorが必要です。dokploy-postgresがまだpostgres:16の場合、アップグレード：

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## ライセンス

アップストリームDokploy（Apache-2.0）に基づく、[LICENSE.MD](../../LICENSE.MD)を参照。

## 貢献

[CONTRIBUTING.md](../../CONTRIBUTING.md)を参照。
