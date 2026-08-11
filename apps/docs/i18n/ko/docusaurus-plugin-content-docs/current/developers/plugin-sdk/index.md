---
title: Plugin SDK 개요
description: Plugin SDK가 무엇인지, 프론트엔드와 백엔드 API가 어떻게 나뉘는지.
sidebar_position: 1
---

Plugin SDK는 플러그인이 NeoTavern을 확장하는 데 사용하는 버전이 있는
공개 API로, 브라우저 측 UI와 서버 측 백엔드를 모두 다룹니다.

## Plugin SDK란?

플러그인은 매니페스트, 선택적인 프론트엔드 및 백엔드 진입점, 에셋을
담는 ZIP 패키지(`.stplugin`)입니다. 플러그인은 `@neotavern/plugin-sdk`
패키지를 통해서만 애플리케이션을 확장합니다. Fastify, React, Zustand,
TanStack Query, SQLite 연결, 내부 컴포넌트를 직접 가져오는 일은
없습니다. 그것들은 호스트의 구현 세부 사항이며 예고 없이
바뀝니다.

SDK는 버전이 있으므로(`apiVersion`은 매니페스트에 있음) 플러그인이
애플리케이션 업데이트를 가로질러 계속 동작합니다. 호스트가 계약을
강제합니다. SDK로 등록한 것은 플러그인이 비활성화될 때 정리되고,
내부 모듈에서 필요할 것 같은 것은 의도적으로 노출되지 않습니다.

## 프론트엔드와 백엔드 분리

플러그인은 두 개의 선택적인 반쪽을 가집니다.

- **프론트엔드** — `activate()` 호출에서 `FrontendPluginApi`를 받는
  브라우저 ESM 진입점. 툴바 작업, 메시지 작업, 슬래시 명령어, 설정
  패널 같은 UI 표면을 등록하고 애플리케이션 이벤트를
  수신합니다.
- **백엔드** — `ServerPluginApi`를 받는 Node.js ESM 진입점.
  `/api/plugins/{pluginId}/` 아래에 라우트를 마운트하고, 격리된
  스토리지를 읽고 쓰며, 권한이 검사된 네트워크 호출을 수행하고,
  프로바이더와 컨텍스트 시프팅 전략을 등록합니다.

두 반쪽 모두 선택 사항입니다. 툴바 버튼만 추가하는 플러그인은
백엔드가 필요 없고, API만 제공하는 플러그인은 프론트엔드가 필요
없습니다. 각 등록은 정리 함수를 반환하며, 런타임이 이를 모아
비활성화 후에 아무것도 남지 않게 합니다.

## 플러그인 작성

`@neotavern/plugin-sdk`에서 `definePlugin`을 가져오고 `activate(api)` 함수가
있는 정의를 내보냅니다.

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const unregister = api.ui.messageActions.register({
      id: 'example.greet',
      title: 'Greet',
      run: ({ message }) => console.log(message.messageId),
    });
    api.events.on('chat.opened', ({ chatId }) => console.log(chatId));
  },
});
```

생성된 [Plugin SDK 레퍼런스](../api/plugin-sdk/)는 모든 내보낸 타입과
함수를 정확한 시그니처와 함께 문서화합니다.

## 다음 단계

- [매니페스트](manifest.md) — 패키지 구조와 `plugin.json` 스키마.
- [권한](permissions.md) — 권한 모델과 동의 흐름.
- [프론트엔드 API](frontend.md) — UI 표면과 이벤트 등록.
- [백엔드 API](backend.md) — 라우트, 스토리지, 서버 추상화.
- [라이프사이클](lifecycle.md) — 설치, 활성화, 비활성화, 정리 보장.
- [샌드박싱](sandboxing.md) — 신뢰할 수 없는 코드의 보안 모델.
