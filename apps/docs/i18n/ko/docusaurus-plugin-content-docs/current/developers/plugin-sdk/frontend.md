---
title: 프론트엔드 플러그인 API
description: 프론트엔드 플러그인이 페이지, 패널, 작업, 명령어, 이벤트를 등록하는 방법.
sidebar_position: 4
---

프론트엔드 API는 브라우저 측 플러그인이 `activate()` 호출에서 받는
것입니다. 모든 UI 표면을 위한 등록자 집합, 이벤트 버스, i18n입니다.

## 진입점

프론트엔드 플러그인은 `activate(api)` 함수가 있는 정의를
내보냅니다. 호스트는 플러그인이 동의되고 활성화되면 `FrontendPluginApi`
객체로 호출합니다.

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    // Register surfaces here.
  },
  deactivate() {
    // Optional explicit teardown.
  },
});
```

모든 등록자는 정리 함수를 반환합니다. 런타임이 자동으로 이를 모으므로
플러그인이 손으로 추적할 필요가 없습니다. 그래도 `deactivate()`에서
직접 관리하는 모든 것을 정리할 수 있습니다.

## 등록 표면

`api.ui` 네임스페이스는 UI 등록자를 묶습니다.

- **페이지** — `api.ui.pages.register({ id, path, title, mount })`가
  플러그인 네임스페이스 아래에 라우트를 추가합니다. `mount`는
  호스트가 제공하는 컨테이너를 받고 정리를 반환할 수 있습니다.
- **설정 패널** — `api.ui.settingsPanels.register(...)`가 설정 화면에
  패널을 추가합니다.
- **툴바 작업** — `api.ui.toolbarActions.register({ id, title, icon,
run })`. 호스트는 작업을 표준 버튼으로 렌더링합니다. 플러그인은
  의미만 제공하며 레이아웃이나 중단점은 제공하지 않습니다.
- **메시지 작업** — `api.ui.messageActions.register({ id, title, icon,
order, placement, run })`. `run` 콜백은 불변 메시지 스냅샷과 정리,
  재호출, 타임아웃 시 발생하는 `AbortSignal`을 받습니다.
- **컨텍스트 메뉴 항목** — `context: 'message' | 'character'`용
  `api.ui.contextMenuItems.register({ id, title, context, run })`.
- **메시지 렌더러** — `api.ui.messageRenderers.register({ id, title,
render })`. `render`는 `placement`가 `'replace'` 또는 `'after'`인
  일반 텍스트를 반환합니다. HTML은 절대 아닙니다.
- **캐릭터 탭** — `api.ui.characterTabs.register({ id, title, mount })`.
  `mount`는 컨텍스트로 `{ characterId }`를 받습니다.
- **사이드바 패널** — `slot: 'left' | 'right'`가 있는
  `api.ui.sidebarPanels.register({ id, title, slot, mount })`.
- **대화상자** — `api.ui.dialogs.register({ id, title, description,
mount })`.
- **명령 팔레트 작업** — `api.ui.commands.register({ id, title, run })`.
- **단축키** — `api.ui.hotkeys.register({ id, combo, run })`. 예:
  `combo: 'mod+shift+k'`.

슬래시 명령어는 `api.slash.register({ name, description, run })`로,
프롬프트 인터셉터는 `api.interceptors`로 별도 등록합니다.

## 프롬프트 인터셉터

인터셉터는 보내기 전에 조립된 프롬프트에서 실행됩니다.

```ts
api.interceptors.register({
  id: 'example.format',
  priority: 100,
  timeoutMs: 5000,
  intercept(context) {
    // context.messages is an array of { id, role, content, name }.
    return context;
  },
});
```

낮은 `priority`가 먼저 실행되며, `timeoutMs`를 초과하는 플러그인은
체인을 깨지 않고 건너뜁니다. 프롬프트만 검사하는 인터셉터는
`prompt.inspect`가, 변경하는 인터셉터는 `prompt.modify`가 필요합니다.

## 이벤트

이벤트 버스는 타입이 있으며 호스트와 공유됩니다. `api.events.on(event,
handler)`은 구독 해제 함수를 반환합니다.

```ts
const off = api.events.on('chat.message.created', ({ chatId, messageId }) => {
  console.log('new message', chatId, messageId);
});
```

기본 제공 이벤트에는 `chat.created`, `chat.opened`,
`chat.message.created`, `chat.message.updated`, `chat.message.deleted`,
`character.selected`, `generation.started`, `generation.delta`,
`generation.finished`, `generation.error`, `theme.changed`,
`language.changed`가 있습니다. 플러그인은 관례에 따라 네임스페이스가
붙은 이름(예: `myplugin.foo`)으로 사용자 지정 이벤트를 내보내고
들을 수도 있습니다.

## 메시지 스냅샷과 콘텐츠 게이팅

메시지 작업은 `messageId`, `chatId`, `branchId`, `role`, `content`,
`name`, `meta`, `revision`이 있는 불변 `MessageActionSnapshot`을
받습니다. `content` 필드는 플러그인이 `chat.read`도 보유하지 않으면
`null`이므로, 작업이 메시지 텍스트를 보지 않고도 메타데이터를 렌더링할
수 있습니다.

## 알림과 i18n

`api.notify({ title, description, variant, timeoutMs })`는 알림을
보여주고 닫기 함수를 반환합니다. `variant`는 `info`, `success`,
`warning`, `error`입니다.

`api.i18n`은 격리된 플러그인 네임스페이스에서 번역 리소스를
관리합니다.

```ts
api.i18n.addResources('ru', { greet: 'Привет' });
const label = api.i18n.t('greet');
```

`addResources`는 다른 모든 등록과 마찬가지로 정리 함수를
반환합니다.

## 정리 보장

모든 등록이 정리 함수를 반환하고 런타임이 이를 추적하므로, 플러그인을
비활성화하면 모든 핸들러, 타이머, DOM 노드, 구독, 백그라운드 요청이
제거됩니다. 전체 정리 계약은 [라이프사이클](lifecycle.md), 정확한
타입은 생성된 [Plugin SDK 레퍼런스](../../api/plugin-sdk/)를 참조하세요.
