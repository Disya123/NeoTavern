---
title: 모노레포 개요
description: >-
  NeoTavern 모노레포 구조, 서버와 웹 사이의 데이터 흐름, 아키텍처를
  형성하는 로컬 퍼스트 원칙.
sidebar_position: 2
---

NeoTavern은 로컬 퍼스트 애플리케이션입니다. 단일 Fastify 프로세스가
API와 선택적인 빌드된 프론트엔드를 제공하며, 외부 데이터베이스,
큐, 컨테이너가 필요하지 않습니다.

## 모노레포 구조

워크스페이스는 `apps/`와 `packages/`라는 두 개의 최상위 그룹으로
이루어진 pnpm 모노레포입니다.

```text
apps/
  server/          # Fastify backend: API, prompt pipeline, SSE, legacy host
  web/             # React SPA
  plugin-runtime/  # Restricted Node.js process for backend plugins
  desktop/         # Tauri 2 shell; runs the server as a sidecar process
packages/
  shared/        # UUIDv7 IDs, Result, errors, logger, async utilities
  contracts/     # TypeBox API schemas — single source of truth
  db/            # SQLite: schema, migrations, repositories, FTS5
  ui/            # Headless components on Radix primitives
  i18n/          # i18next setup and language resources
  plugin-sdk/    # Plugin manifest, permissions, and API contracts
  theme-sdk/     # Theme tokens, levels, and inheritance
  provider-sdk/  # Provider adapter contract and adapters
  legacy-compat/ # window globals and DOM compatibility islands
  gestures/      # Framework-agnostic row gestures
  plugin-build/  # Plugin build and publish pipeline
```

## 앱

- `apps/server` — Fastify 백엔드. `/api/v2/*` API를 노출하고 프롬프트
  파이프라인을 실행하며 SSE로 생성 스트리밍을 전송하고 Express 호환
  레거시 표면을 호스팅합니다. 각 모듈은 격리된 Fastify
  플러그인입니다.
- `apps/web` — React SPA. HTTP로 서버와 통신하며 채팅 워크스페이스와
  캐릭터, 설정, 프로바이더, 테마, 플러그인 표면을 렌더링합니다.
- `apps/plugin-runtime` — 신뢰할 수 없는 백엔드 플러그인이 실행되는
  권한 제한 Node.js 프로세스로, 메인 서버 프로세스와 격리됩니다.
- `apps/desktop` — Tauri 2 셸. 컴파일된 서버를 자체 포함 Node.js
  사이드카로 실행하고 로컬 API가 준비된 후에만 웹뷰를 엽니다.

## 패키지

공유 코드는 `packages/` 아래의 좁은 범위의 패키지에 있습니다. 모든
패키지는 하나의 역할을 가지며, 의존성은 아래 방향으로만
향합니다. `server`와 `web`은 패키지에 의존하고, 패키지는 기껏해야
`shared`와 `contracts`에 의존합니다. 전체 설명은
[패키지](packages)를 참조하세요.

## 데이터 흐름

일반적인 요청은 다음 계층을 통과합니다.

1. 프론트엔드가 TanStack Query를 통해 `/api/v2/*` 엔드포인트를
   호출합니다.
2. Fastify가 TypeBox 스키마로 입력을 검증하고 `{ code, params, traceId }`
   봉투 형식으로 오류를 반환합니다.
3. `@neotavern/db`의 리포지토리가 커서 페이지네이션과 FTS5 검색으로
   SQLite를 읽고 씁니다.
4. 생성은 `POST /api/v2/chats/:id/generate`로 실행됩니다. 프롬프트
   파이프라인이 컨텍스트를 조립하고, 프로바이더 어댑터가 요청을
   직렬화하며, 응답이 SSE로 스트리밍되고, 메시지가 저장됩니다.

웹 앱은 단일 페이지입니다. 라우트가 채팅 워크스페이스를 바꾸고,
캐릭터, 설정, 프로바이더, 테마, 플러그인은 보존된 채팅 위치 위의
대화상자 표면에 렌더링됩니다.

## 로컬 퍼스트 원칙

모든 것이 내 기기에서 실행됩니다.

- 백엔드는 기본적으로 `127.0.0.1`에 바인딩됩니다. 원격 접근은 제한된
  세션과 HTTPS 요구 사항이 있는 명시적 선택(opt-in)입니다.
- 모든 데이터는 하나의 로컬 데이터 디렉터리에 있습니다. 단일 SQLite
  데이터베이스와 콘텐츠 주소 지정 파일 저장소입니다. PostgreSQL,
  Redis, Docker가 없습니다.
- 앱은 오프라인으로 동작합니다. 프로바이더 호출이 유일한 네트워크
  트래픽이며, 기본 제공 `echo` 어댑터로 프로바이더 없이 전체
  파이프라인을 테스트할 수 있습니다.
- 백업, 내보내기, SillyTavern 가져오기는 모두 같은 SQLite 및 파일
  API를 통해 로컬에서 이루어집니다.

저장소 계층은 [데이터 및 저장소](../data/), 생성 경로는 [프롬프트
파이프라인](../prompt-pipeline/)을 참조하세요.
