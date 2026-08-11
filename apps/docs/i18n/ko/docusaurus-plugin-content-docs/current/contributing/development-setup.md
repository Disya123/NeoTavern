---
title: 개발 환경 구성
description: NeoTavern 개발 환경을 설정하고 프로젝트를 로컬에서 실행하는 방법
sidebar_position: 2
---

이 페이지는 NeoTavern 개발 환경을 설정하고 프로젝트를 로컬에서
실행하는 방법을 설명합니다.

## 사전 요구 사항

- Node.js 24 LTS 이상 — 프로젝트는 Node `>= 24`가 필요합니다.
- pnpm 9 — 워크스페이스는 pnpm `>= 9` 및 `< 10`이 필요하며
  `packageManager: pnpm@9.15.0`을 선언합니다. corepack으로 활성화하거나
  직접 설치하세요.
- Windows, macOS, Linux. 데스크톱 앱은 최종 사용자용 자체 Node.js
  런타임을 번들하지만, 개발은 항상 설치된 Node.js를 사용합니다.

## 의존성 설치

```bash
pnpm install
```

이 명령은 모든 워크스페이스 패키지를 설치합니다. 저장소는 pnpm
모노레포입니다. 애플리케이션은 `apps/`(server 및 web)에 있고 공유
라이브러리는 `packages/`에 있습니다.

## 개발 실행

```bash
pnpm dev
```

Fastify 백엔드와 Vite 웹 앱을 핫 리로드와 함께 병렬로 시작합니다.
별도로 실행하려면:

```bash
pnpm dev:server
pnpm dev:web
```

Vite 개발 서버가 출력한 URL을 열고, 설정에서 프로바이더를 연결한 뒤
첫 메시지를 보내 전체 파이프라인(채팅, 서버, 프로바이더, 스트리밍,
저장)을 검증하세요.

## 품질 게이트

푸시 전에 다음을 실행하세요.

```bash
pnpm typecheck    # TypeScript across the monorepo
pnpm lint         # ESLint, zero warnings allowed
pnpm test         # Vitest unit and integration tests, plus web tests
pnpm test:e2e     # Playwright end-to-end suite (builds the workspace first)
pnpm build        # full workspace build (tsc -b and Vite)
pnpm format:check # Prettier check
```

`pnpm test:e2e`는 먼저 워크스페이스 전체를 컴파일하므로 다른 검사보다
오래 걸립니다. `docs:check`와 `docs:build` 스크립트는 내부 개발자
문서를 검증하며, 공개 사이트는 [문서 사이트](./docs-site) 페이지에
문서화된 자체 명령어를 가집니다.

## 데스크톱 개발

데스크톱 셸(Tauri)과 Node 사이드카는 별도의 애플리케이션입니다.

```bash
pnpm desktop:dev       # run the desktop app in development
pnpm desktop:portable  # build the portable Windows package
pnpm desktop:release   # build installer packages
```

데스크톱 패키징은 OS별 도구 체인을 포함합니다. 자세한 내용은 개발자
문서의 [데스크톱](../developers/desktop/) 섹션을 참조하세요.

## 흔한 문제

- `pnpm install` 또는 `pnpm dev`가 실패한다면 `node -v`가 24 이상이고
  `pnpm -v`가 9임을 확인하세요.
- 개발 서버가 시작되지 않는다면 서버와 Vite가 사용하는 포트를 다른
  프로세스가 점유하지 않았는지 확인한 뒤 `pnpm dev`를 다시
  실행하세요.
