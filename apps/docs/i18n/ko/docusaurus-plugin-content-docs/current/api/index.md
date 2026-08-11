---
title: SDK 레퍼런스
description: 네 개의 공개 SDK 패키지에 대한 자동 생성 TypeDoc 레퍼런스 개요입니다.
sidebar_position: 1
---

SDK 레퍼런스는 NeoTavern이 플러그인, 테마, 프로바이더 작성자에게
노출하는 네 개의 공개 TypeScript 패키지에 대한 자동 생성 API
레퍼런스입니다.

## 생성되는 것

레퍼런스는 모든 사이트 빌드 중 TypeDoc이 각 패키지의 `src/index.ts`
진입점에서 생성합니다. 정확한 내보내기 표면을 문서화합니다.

- **Plugin SDK** — `@neotavern/plugin-sdk`: 매니페스트 검증, 권한 모델,
  타입이 있는 이벤트, 프론트엔드 및 백엔드 플러그인 API 계약.
- **Theme SDK** — `@neotavern/theme-sdk`: 디자인 토큰 계약, 테마 매니페스트
  검증, 상속 해석, CSS 변수 생성.
- **Provider SDK** — `@neotavern/provider-sdk`: 프로바이더 어댑터 계약,
  기본 제공 어댑터, 토큰 추정, 런타임 레지스트리.
- **Contracts** — `@neotavern/contracts`: 백엔드 라우트와 프론트엔드 타입이
  모두 파생하는 공유 요청, 응답, 엔티티 스키마.

생성된 페이지는 손으로 작성되지 않으며 저장소에 커밋되지 않습니다.
모든 빌드에서 다시 만들어지므로 항상 패키지의 현재 `src/`와
일치합니다.

## 레퍼런스 재생성

Docusaurus 빌드라면 파이프라인의 일부로 레퍼런스를 재생성합니다.

```bash
pnpm --filter @neotavern/docs build
```

SDK 소스 파일을 변경한 후 새 레퍼런스를 원하면 로컬에서 같은 명령어를
실행하세요.

## 패키지 탐색

- [Plugin SDK 레퍼런스](api/plugin-sdk/)
- [Theme SDK 레퍼런스](api/theme-sdk/)
- [Provider SDK 레퍼런스](api/provider-sdk/)
- [Contracts 레퍼런스](api/contracts/)

원시 API 목록 대신 사용 가이드가 필요하면 이 문서의 Plugin SDK, Theme
SDK, 프로바이더 섹션을 참조하세요. 계약을 예시와 함께 글로 설명하고
정확한 시그니처는 생성된 페이지로 다시 연결합니다.
