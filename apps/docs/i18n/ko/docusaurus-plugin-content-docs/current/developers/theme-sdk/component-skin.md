---
title: 컴포넌트 스킨
description: 캐스케이드 레이어부터 안정적인 훅까지, 테마 스킨의 스타일링 스택.
sidebar_position: 4
---

컴포넌트 스킨 레벨은 기본 제공 컴포넌트를 다시 스타일링합니다.
특정한 스타일링 스택과 안정적인 훅 계약 위에 구축됩니다.

## 스타일링 스택

기본 제공 UI는 네 가지 기술을 함께 사용합니다.

- 컴포넌트 범위 스타일용 **CSS Modules**. 해시된 클래스 이름은
  명시적으로 공개 계약이 아닙니다.
- 의미적 토큰(`--st-*`)용 **CSS 사용자 지정 속성**.
- 진실 공급원의 순서를 정하는 **캐스케이드 레이어**.
- 컴포넌트 자체 컨테이너에 적응하는 레이아웃용 **컨테이너 쿼리**.
  크기는 `rem`으로 표현됩니다.

테마는 생성된 클래스 이름이 아니라 훅 속성을 대상으로 합니다.

## 캐스케이드 레이어 순서

모든 스타일은 고정된 캐스케이드 레이어 순서로 존재합니다.

```css
@layer reset, tokens, base, components, plugin-base, theme, user;
```

나중 레이어가 앞선 레이어를 이기므로 우선순위는 다음과 같습니다.

1. `reset` — 기본 리셋.
2. `tokens` — 토큰 정의.
3. `base` — 요소 수준 기본값.
4. `components` — 기본 제공 컴포넌트 스타일.
5. `plugin-base` — 플러그인이 제공하는 기본 스타일용 레이어.
6. `theme` — 활성 테마의 스킨.
7. `user` — 사용자 자신의 오버라이드. 마지막에 로드됩니다.

사용자 오버라이드 스타일시트는 항상 마지막에 로드되므로 망가졌거나
독단적인 테마도 사용자가 오버라이드하는 것을 막을 수 없습니다.
`!important` 관점에서: 이 구문은 사용자 대상 접근성 모드에 속하는
접근성 기본 설정 레이어를 제외하고 테마 CSS에서 금지됩니다.

## 훅 계약

테마는 호스트가 게시하고 SDK의 나머지처럼 버전이 관리되는 네 개의
속성으로 컴포넌트를 스타일링합니다.

```html
<div
  data-component="chat-message"
  data-part="container"
  data-role="assistant"
  data-state="streaming"
></div>
```

- `data-component` — 컴포넌트 종류.
- `data-part` — 컴포넌트 안의 구조적 부분.
- `data-role` — 메시지 역할 같은 의미적 역할.
- `data-state` — `open`, `closed`, `streaming` 같은 상태.

테마의 스킨 CSS는 다음과 같습니다.

```css
@layer theme {
  [data-component='button'][data-variant='primary'] > [data-part='icon'] {
    color: var(--st-color-accent-text);
  }

  [data-component='action-bar'] [data-part='group'][data-role='secondary'] {
    color: var(--st-color-text-secondary);
  }
}
```

`@neotavern/theme-sdk` 패키지는 이 속성 객체를 만드는 `dataHook` 헬퍼를
내보내므로 컴포넌트 작성자와 테마 작성자가 같은 이름에
동의합니다.

## 계약이 아닌 것

- **생성된 CSS 모듈 클래스 이름** — 해시되어 불안정하며 SDK의 일부가
  아닙니다. 이를 대상으로 하는 테마는 다음 빌드에서 깨집니다.
- **내부 React 계층** — 테마는 문서화된 훅 너머의 컴포넌트 내부나
  DOM 순서에 의존해서는 안 됩니다.
- **숫자 레이아웃 값** — 좌표, 그리드 구성, 중단점은 토큰 계약으로
  스타일링할 수 없습니다. 뷰포트 중단점은 레지스트리에 있고 컨테이너
  쿼리는 `rem`으로 작성해야 합니다.

## 금지된 CSS

테마 스타일시트는 로드되기 전에 검사됩니다. 금지된 구문은 설치 및
검증 시점에 거부됩니다.

- `@import`
- `javascript:` URL 및 `expression()`.
- `-moz-binding` 및 `behavior:`.
- 원격 또는 프로토콜 상대 URL(`url(http:`, `url(https:`, `url(//`).
- `data:text/html`.
- `!important`(접근성 기본 설정 레이어 제외).

이렇게 해서 테마 CSS는 순수하고 로컬이며 안전하게 유지됩니다. 스킨이
참조해야 하는 토큰은 [디자인 토큰](design-tokens.md), 스킨이 다시
스타일링할 수 있는 명명된 영역은 [셸 계약](shell-contract.md)을
참조하세요.
