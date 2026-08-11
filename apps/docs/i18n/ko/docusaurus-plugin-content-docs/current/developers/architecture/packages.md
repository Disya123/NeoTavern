---
title: 패키지
description: >-
  각 워크스페이스 패키지의 역할과 모노레포를 순환 의존성 없이
  유지하는 의존성 방향.
sidebar_position: 4
---

모든 워크스페이스 패키지는 정확히 하나의 역할을 가지며, 의존성은
아래 방향으로만 향합니다. 덕분에 모노레포에는 순환 의존성이
없습니다.

## 의존성 방향

코드는 "아래" 패키지에만 의존할 수 있습니다.

```text
apps (server, web, desktop, plugin-runtime)
  → packages
  → shared, contracts (the floor)
```

`server`와 `web`은 패키지에 의존하고, 패키지는 기껏해야 `shared`와
`contracts`에 의존합니다. 순환 의존성은 금지됩니다. 새 코드를 추가할
때는 그것을 호스팅할 수 있는 가장 좁은 패키지에 넣으세요. 공유
헬퍼는 `@neotavern/shared`, API 형태는 `@neotavern/contracts`, 데이터베이스 관련
무엇이든 `@neotavern/db`로 갑니다.

## 패키지 역할

- `@neotavern/shared` — 런타임 의존성이 없는 동형 유틸리티: UUIDv7 ID,
  `Result`, `AppError` 봉투, 비밀을 비식별화하는 구조적 로거, 타임아웃
  및 신호 헬퍼, 프롬프트 매크로.
- `@neotavern/contracts` — 모든 API 입력과 출력의 TypeBox 스키마. 서버와 웹이
  공유하는 단일 진실 공급원이며 손으로 중복 작성하지 않습니다.
- `@neotavern/db` — SQLite: Drizzle 스키마, 마이그레이션, 리포지토리, FTS5
  검색. 데이터베이스와 통신하는 유일한 패키지.
- `@neotavern/ui` — Radix 프리미티브, 디자인 토큰, 테마가 의존하는 `data-*`
  훅 위에 구축된 헤드리스 기본 컴포넌트.
- `@neotavern/i18n` — i18next 설정, 네임스페이스, `en` 및 `ru` 리소스, 기계
  오류 코드를 지역화된 텍스트로 매핑하는 오류 코드 지역화기.
- `@neotavern/plugin-sdk` — 버전이 있는 Plugin SDK: 매니페스트 스키마, 권한과
  능력 부여, 플러그인이 컴파일 대상으로 삼는 프론트엔드 및 백엔드 API
  계약.
- `@neotavern/theme-sdk` — Theme SDK: 매니페스트 스키마, 토큰/컴포넌트/셸
  레벨, 상속 해석.
- `@neotavern/provider-sdk` — 통합 프로바이더 어댑터 계약과 LLM, TTS, STT,
  이미지 프로바이더용 기본 제공 어댑터, 어댑터 레지스트리.
- `@neotavern/legacy-compat` — 레거시 호환 계층: `window` 전역, 이벤트 버스,
  SillyTavern 시대 스크립트용 비관리 DOM 섬.
- `@neotavern/gestures` — 프레임워크에 구애받지 않는 행 제스처: 컨텍스트
  메뉴(오른쪽 클릭 및 길게 누르기)와 드래그 앤 드롭 재정렬 인식.
- `@neotavern/plugin-build` — 플러그인 빌드 및 게시 파이프라인: 분석, 서명,
  플러그인 패키지 빌드.

## 무엇이 어디에 사는가

- **API 형태**는 항상 `@neotavern/contracts`에서 옵니다. 백엔드와 프론트엔드가
  같은 타입을 두 번 선언하지 않습니다.
- **데이터베이스 접근**은 `@neotavern/db` 리포지토리를 통해서만
  이루어집니다. 플러그인 코드는 SQLite 연결을 받지 않습니다.
- **프로바이더 동작**은 `@neotavern/provider-sdk` 어댑터에 있습니다. 서버
  코어는 단일 프로바이더의 SDK에 결합되지 않습니다. 문서화된 예외가
  하나 있는데, Anthropic 어댑터는 베타 표면에 공식 SDK를 사용합니다.
- **UI 구성 블록**은 `@neotavern/ui`에서 오며, 애플리케이션 화면이 이를
  조합합니다. 프레임워크에 구애받지 않는 제스처는 React 밖에서도
  재사용할 수 있도록 `@neotavern/gestures`에 있습니다.

## 패키지 추가

새 패키지에는 목적, 공개 진입점, 의존성, 제약 조건을 밝히는
`README.md`가 필요합니다. 문서는 구현의 일부입니다. 만들기 전에 코드가
기존 패키지에 맞는지 확인하세요. 기본 답변은 새 패키지 없음입니다.
