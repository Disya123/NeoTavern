---
title: 기술 스택
description: >-
  승인된 NeoTavern 스택: Node.js 24, Fastify 5, React 19, Vite 8,
  엄격한 TypeScript, Drizzle이 있는 SQLite, Tauri 2.
sidebar_position: 3
---

NeoTavern은 의도적으로 평범한 스택에서 실행됩니다. Node.js 24 LTS,
Fastify 5, React 19, Vite 8, 엄격한 TypeScript, Drizzle ORM이 있는
SQLite, Tauri 2 데스크톱 셸입니다.

## 런타임 및 언어

- **Node.js 24 LTS** — 백엔드와 번들된 데스크톱 사이드카의 런타임.
  가능하면 코드는 Node.js 22와도 호환되도록 유지됩니다.
- **엄격한 TypeScript** — 모든 곳에서 활성화됩니다. 정당화되지 않은
  `any`, `as unknown as`, `@ts-ignore`, non-null 단언은 금지됩니다.
  시스템 경계에서는 `unknown`과 명시적 검증을 사용합니다.
- **ESM 전용** — 모든 앱과 패키지는 ES 모듈을 사용합니다.

## 백엔드

- **Fastify 5** — API 프레임워크. 모든 백엔드 모듈은 격리된 Fastify
  플러그인입니다.
- **TypeBox + Fastify Type Provider** — 모든 API 입력과 출력에는
  `@neotavern/contracts`에서 생성된 JSON 스키마가 있습니다.
- **SSE** — 스트리밍 생성은 Server-Sent Events로 실행됩니다.
  WebSocket은 진정한 양방향 채널을 위해 예약되어 있습니다.
- **AbortSignal** — 모든 장기 실행 작업은 `AbortSignal`을 받으며
  클라이언트가 연결을 끊으면 깨끗하게 타임아웃됩니다.

## 프론트엔드

- **React 19** — 서버 측 렌더링이 없는 단일 페이지 앱.
- **Vite 8** — 번들러 및 개발 서버. Vite는 빌드 도구일 뿐
  애플리케이션 플러그인 API가 아닙니다.
- **React Router** — 라우팅. 단일 채팅 워크스페이스와 그 위에
  렌더링되는 시스템 표면을 가집니다.
- **TanStack Query** — 서버 상태의 유일한 저장소.
- **Zustand** — 일시적 UI 상태 전용: 활성 패널, 테마와 언어 기본 설정,
  고정된 캐릭터, 제한된 세션 전용 초안.
- **Radix Primitives** — `@neotavern/ui`가 감싸는 접근성 있는 헤드리스
  컴포넌트.

## 데이터

- **better-sqlite3을 통한 SQLite** — 단일 데이터베이스 파일. WAL,
  `foreign_keys = ON`, `busy_timeout`, 준비된 문(prepared statement)으로
  열립니다.
- **Drizzle ORM** — 타입이 있는 스키마, 리포지토리, 마이그레이션.
- **FTS5** — 캐릭터, 채팅, 메시지 전체 텍스트 검색.

## 스타일링

- **CSS Modules + 사용자 지정 속성 + 캐스케이드 레이어 + 컨테이너
  쿼리** — 스타일링 도구 모음. 테마는 특수성과 싸우지 않고 디자인
  토큰과 레이어 규칙을 오버라이드합니다.

## 템플릿 및 지역화

- **Handlebars** — 인스트럭트 포맷 템플릿. 파일 시스템이나 코드
  실행 접근이 없는 샌드박스 환경에서 렌더링됩니다.
- **i18next** — 모든 사용자 대상 문자열. 네임스페이스와 로케일별
  리소스를 사용합니다.

## 데스크톱

- **Tauri 2** — 데스크톱 셸. Node.js 서버가 자체 포함 사이드카
  바이너리로 함께 제공됩니다.
- **tauri-plugin-shell 및 tauri-plugin-updater** — 프로세스 관리와
  서명된 업데이트.

## 도구

- **pnpm 워크스페이스** — 모노레포 패키지 매니저.
- **Vitest** — 단위 및 통합 테스트.
- **Playwright** — 데스크톱 셸 스모크 테스트를 포함한 엔드투엔드
  테스트.

## 의도적으로 없는 것

- PostgreSQL, Redis, Docker 또는 설치하고 실행해야 하는 다른 서비스가
  없습니다.
- API 프로세스 외부의 SSR이나 프론트엔드용 Node 서버가 없습니다.
- 플러그인 보안 샌드박스로 `node:vm`을 사용하지 않습니다. 신뢰할 수
  없는 백엔드 플러그인은 대신 별도의 제한된 프로세스에서 실행됩니다.

부품이 어떻게 맞물리는지는 [모노레포 개요](overview), 누가 무엇을
소유하는지는 [패키지](packages)를 참조하세요.
