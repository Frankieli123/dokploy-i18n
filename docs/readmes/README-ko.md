<div align="center">
  <a href="https://dokploy.com">
    <img src="../../.github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%" />
  </a>
  <br />
  <br />

  [![License](https://img.shields.io/github/license/Frankieli123/dokploy-i18n?style=flat-square)](../../LICENSE.MD)
  [![Stars](https://img.shields.io/github/stars/Frankieli123/dokploy-i18n?style=flat-square)](https://github.com/Frankieli123/dokploy-i18n/stargazers)
  [![Docker Pulls](https://img.shields.io/docker/pulls/a3180623/dokploy-i18n?style=flat-square)](https://hub.docker.com/r/a3180623/dokploy-i18n)

  <p>Discord에 참여하여 도움, 피드백 및 토론을 받아보세요!</p>
  <a href="https://discord.gg/2tBnJ3jDJc">
    <img src="https://discordapp.com/api/guilds/1234073262418563112/widget.png?style=banner2" alt="Discord Shield" />
  </a>
</div>

# Dokploy i18n

공식 [Dokploy](https://github.com/Dokploy/dokploy)를 기반으로 한 커뮤니티 확장 버전:

- **i18n** — 20개 이상의 언어 지원
- **AI 어시스턴트 패널** — 채팅/에이전트, 도구 호출 승인, MCP 서버
- **볼륨 백업** — Docker 볼륨/바인드 마운트의 외부 저장소 정기 백업, 복원 지원

> 공식 문서: [docs.dokploy.com](https://docs.dokploy.com)

---

**언어**:&ensp;
[简体中文](README-zh-Hans.md) |
[繁體中文](README-zh-Hant.md) |
[English](README-en.md) |
[日本語](README-ja.md) |
[한국어](README-ko.md) |
[Русский](README-ru.md) |
[더보기...](./)

---

## 목차

- [빠른 시작](#빠른-시작)
- [볼륨 백업](#볼륨-백업)
- [AI 어시스턴트 패널](#ai-어시스턴트-패널)
- [라이선스](#라이선스)

## 빠른 시작

> 요구사항: root 권한, 포트 80/443/3000 사용 가능, Docker Swarm

| 시나리오 | 명령어 |
|------|------|
| **표준** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install.sh \| bash` |
| **데이터를 /data에** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data.sh \| bash` |
| **중국 네트워크** | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-china.sh \| bash` |
| **중국 + /data** (권장) | `curl -fsSL https://raw.githubusercontent.com/Frankieli123/dokploy-i18n/main/install-data-china.sh \| bash` |

설치 후 방문: `http://<your-server-ip>:3000`

## 볼륨 백업

공식 Dokploy는 데이터베이스 백업만 지원합니다. 이 포크는 **볼륨 백업**을 추가하여 모든 서비스(애플리케이션, Compose, 데이터베이스)의 Docker 볼륨과 바인드 마운트에 대한 정기 백업 및 복원을 가능하게 합니다.

**진입**: 앱/서비스 상세 페이지로 이동 -> `볼륨 백업` 탭

**기능**:
- Cron을 통한 S3 등으로 자동 백업 예약
- Docker Named Volume, 바인드 마운트 지원, 모든 마운트 일괄 백업
- 최신 N개 백업 보관, 오래된 백업 자동 정리
- 데이터 일관성을 위해 백업 전 컨테이너 정지 선택 가능
- 백업에서 복원

## AI 어시스턴트 패널

**진입**: 대시보드 로그인 -> 오른쪽 하단 봇 버튼 클릭

**활성화**: `대시보드 → 설정 → AI` (`/dashboard/settings/ai`) -> AI 공급자 추가 (OpenAI / Anthropic / Gemini / Ollama 등)

**기능**:
- 채팅/에이전트 두 가지 모드
- 도구 호출 승인: 스트리밍 중단 및 백엔드 실행 취소 가능
- MCP 서버: 패널에서 관리, 대화에서 호출 가능

### pgvector 의존성

Embedding/벡터 검색을 활성화하려면 PostgreSQL에 pgvector가 필요합니다. dokploy-postgres가 여전히 postgres:16인 경우, 업그레이드:

```bash
docker service update --force --image pgvector/pgvector:pg16 dokploy-postgres
docker service update --force dokploy
```

## 라이선스

업스트림 Dokploy(Apache-2.0) 기반, [LICENSE.MD](../../LICENSE.MD) 참조.

## 기여

[CONTRIBUTING.md](../../CONTRIBUTING.md) 참조.
