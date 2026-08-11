---
title: 디자인 토큰
description: 의미적 디자인 토큰 계약과 컴포넌트가 하드코딩해서는 안 되는 것.
sidebar_position: 3
---

디자인 토큰은 애플리케이션의 모든 시각적 값을 담는 의미적
변수입니다. 컴포넌트는 이를 참조하고, 테마는 이를 오버라이드하며,
아무것도 하드코딩되지 않습니다.

## 토큰 계약

모든 토큰은 `--st-` 접두사가 붙은 CSS 사용자 지정 속성이며, 모든 토큰
이름은 `@neotavern/theme-sdk`의 버전이 있는 계약의 일부입니다. 호스트는
라이트 및 다크 모드용 기본값을 제공하므로 테마가 아무것도 정의하지
않아도 모든 토큰이 항상 해석됩니다.

표준 토큰 그룹은 다음과 같습니다.

- **텍스트 색상** — `color-text-primary`, `color-text-secondary`,
  `color-text-muted`, `color-text-inverse`, `color-text-link`.
- **표면** — `color-surface-primary`, `color-surface-secondary`,
  `color-surface-tertiary`, `color-surface-overlay`, `color-surface-canvas`,
  `color-surface-elevated`.
- **강조 및 상태** — `color-accent`, `color-accent-hover`,
  `color-accent-text`, `color-accent-soft`, `color-accent-soft-text`,
  `color-border`, `color-border-strong`, `color-success`, `color-warning`,
  `color-danger`, `color-info`.
- **채팅 메시지 마크다운** — `color-message-quote`,
  `color-message-emphasis`, `color-message-code`, `color-message-code-bg`.
- **타이포그래피** — `font-ui`, `font-mono`, `font-size-2xs`부터
  `font-size-2xl`까지, `line-height-body`, `font-weight-normal`부터
  `font-weight-bold`까지.
- **간격** — `space-2xs`부터 `space-3xl`까지.
- **모서리 반경 및 테두리** — `radius-control`, `radius-card`,
  `radius-overlay`, `radius-panel`, `radius-round`, `radius-inset`,
  `border-width`.
- **높이(그림자)** — `shadow-card`, `shadow-soft`, `shadow-focus`,
  `shadow-overlay`.
- **레이어(z-index)** — `layer-base`, `layer-raised`, `layer-panel`,
  `layer-plugin-overlay`, `layer-plugin-chrome`, `layer-dropdown`,
  `layer-modal`, `layer-notification`.
- **모션** — `motion-duration-fast`, `motion-duration-normal`,
  `motion-duration-slow`, `motion-easing-standard`, `effect-glass-blur`.
- **컨트롤 크기** — `control-height`, `control-height-large`,
  `control-height-sm`, `control-height-xs`, `control-height-2xs`,
  `control-hit-min`, `switch-width`, `switch-height`, `switch-thumb-size`,
  `menu-min-width`, `dialog-max-width`, `dialog-max-height`,
  `textarea-min-height`, `spinner-size`.
- **패널 및 콘텐츠 크기** — `size-panel-max-height`,
  `size-content-max-height`, `size-chat-column-max`.
- **뷰포트 제한** — `overlay-width-limit`, `overlay-height-limit`,
  `dialog-sheet-height`.
- **스크롤바** — `scrollbar-width`, `scrollbar-radius`,
  `scrollbar-track-bg`, `scrollbar-thumb-bg`, `scrollbar-thumb-hover-bg`,
  `scrollbar-fade-duration`, `scrollbar-fade-easing`,
  `scrollbar-hide-delay`.
- **앱 셸 크기** — `shell-rail-width`, `shell-panel-width`,
  `shell-panel-min-width`, `shell-panel-max-width`.
- **채팅 캔버스** — `chat-wallpaper-image`, `chat-wallpaper-position`,
  `chat-wallpaper-size`, `chat-wallpaper-overlay`, `chat-wallpaper-blur`,
  `custom-wallpaper-overlay-alpha`.
- **채팅 타이포그래피 지표** — `chat-markdown-column-width`,
  `chat-message-block`, `chat-message-inline`.
- **사용자 조정 손잡이** — `custom-glass-blur`, `custom-ui-opacity`.

## 토큰 오버라이드

테마는 이름의 어떤 부분 집합이든 오버라이드합니다. 값은
검증됩니다. 안전한 비어 있지 않은 CSS 값이어야 하며 `{`, `}`, `;`
같은 구문은 거부됩니다.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#e38a62",
      "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.35)"
    }
  }
}
```

사용자가 채팅 배경을 선택하면 애플리케이션은 워크스페이스 루트에
배경화면 이미지용 범위가 지정된 사용자 지정 속성을 설정합니다.
위치, 크기, 오버레이, 블러는 테마의 토큰으로 남습니다.

## 해석 규칙

토큰은 이 순서로 해석되며, 나중 것이 이깁니다.

1. 활성 모드의 기본 제공 기본값.
2. 부모 테마 체인, 루트부터.
3. 테마 자체.

다크 오버라이드가 없으면 다크 모드는 테마의 라이트 토큰으로
폴백하므로 라이트 전용 테마도 다크 모드에서 동작합니다.
`@neotavern/theme-sdk`의 `resolveTokens` 및 `buildThemeVariables` 함수가 이를
구현하며, 호스트는 결과를 `document.documentElement`의 CSS 변수로
씁니다.

## 컴포넌트가 하드코딩해서는 안 되는 것

스타일 계약은 기본 제공 UI 어디에서도 하드코딩된 값을 금지하며, 테마가
의존해서도 안 되는 것에도 같은 규칙이 적용됩니다.

- 숫자 `font-weight`, px 단위 `font-size`, 원시 px 단위
  `border-radius`.
- 숫자 `z-index` 값 — `layer-*` 토큰을 사용하세요.
- `40px`, `44px`, `52px`, `32px`, `36px` 같은 컨트롤 크기.
- 접근성 기본 설정 레이어를 제외한 테마 CSS의 `!important`.
- 레이아웃 규칙: 좌표, 그리드 및 플렉스 구성, 중단점, 영역 순서는
  토큰 계약의 일부가 아닙니다. 중단점은 레지스트리(`VIEWPORT_BREAKPOINTS`
  및 `CONTAINER_BREAKPOINTS`)에서 오며, 셸 영역 이동은 v1 범위
  밖입니다.

카드 목록의 그리드 구성 같은 콘텐츠 지오메트리는 명시적 예외입니다.
토큰 계약이 다루지 않습니다. 테마가 다시 스타일링하는 데 필요한 모든
것은 토큰, 훅, 선언적 셸 레이아웃을 통해 사용할 수 있습니다. 생성된
[Theme SDK 레퍼런스](../../api/theme-sdk/)는 정확한 `TokenName` 목록을
문서화합니다.
