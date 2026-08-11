---
title: 테마 레벨
description: 테마의 세 가지 레벨 — 토큰, 컴포넌트 스킨, 셸 레이아웃.
sidebar_position: 2
---

테마는 세 가지 독립적인 레벨로 만들어집니다. 이 구분을 이해하는 것이
테마가 동작을 건드리지 않고 애플리케이션 전체의 모양을 바꾸는
방법입니다.

## 레벨 1: 디자인 토큰

토큰은 `--st-` 접두사가 붙은 의미적 CSS 사용자 지정 속성입니다.
색상, 타이포그래피, 간격, 모서리 반경, 테두리, 그림자, z-index 레이어,
모션, 컨트롤 크기, 스크롤바, 채팅 캔버스를 다룹니다.

컴포넌트는 토큰만 참조하며 색상, 글꼴, 간격 값을 절대 하드코딩하지
않습니다. 테마 매니페스트에서 토큰을 오버라이드하면 그 토큰을 사용하는
모든 컴포넌트가 다시 스타일링됩니다.

```json
{
  "tokens": {
    "dark": {
      "color-accent": "#ff00aa",
      "font-ui": "'Atkinson Hyperlegible', system-ui, sans-serif"
    }
  }
}
```

토큰은 상속 체인을 통해 해석됩니다. 모드의 기본 제공 기본값, 그다음
부모 테마, 마지막으로 테마 자체입니다. 다크 오버라이드가 없으면 다크
모드는 테마의 라이트 토큰으로 폴백합니다. 전체 계약은 [디자인
토큰](design-tokens.md)을 참조하세요.

## 레벨 2: 컴포넌트 스킨

컴포넌트 스킨은 안정적인 훅을 통해 기본 제공 컴포넌트를 다시
스타일링하는 CSS입니다. 호스트가 `data-component`, `data-part`,
`data-role`, `data-state` 속성을 게시하고, 테마는 생성된 CSS 모듈
클래스 이름이 아니라 이 속성을 스타일링합니다.

```css
@layer theme {
  [data-component='button'][data-variant='primary'] {
    background: var(--st-color-accent);
  }
}
```

스킨은 고정된 순서의 캐스케이드 레이어로 적용되며 사용자 오버라이드
레이어가 마지막입니다. `!important`는 접근성 기본 설정 레이어를
제외하고 테마 CSS에서 금지됩니다. 레이어 순서와 훅 레퍼런스는
[컴포넌트 스킨](component-skin.md)을 참조하세요.

## 레벨 3: 셸 레이아웃

셸 레이아웃은 주요 영역의 구성입니다. 내비게이션 레일, 관리 패널,
채팅 워크스페이스입니다. JavaScript가 아니라 `theme.json`에 표현되는
선언적 형식입니다.

```json
{
  "shellLayout": {
    "navigationRail": {
      "main": [
        "menu-toggle",
        "chats",
        "characters",
        "personas",
        "lorebooks",
        "backgrounds",
        "ai-settings",
        "plugins"
      ],
      "bottom": ["settings"]
    }
  }
}
```

유효한 레일 항목은 `chats`, `characters`, `personas`, `lorebooks`,
`backgrounds`, `ai-settings`, `plugins`, `settings`, 선택적인
`menu-toggle`입니다. `main` 그룹은 위에서부터 흐르고 `bottom`은 아래
가장자리에 고정됩니다. 생략한 항목은 표준 순서로 다시 추가되므로
테마가 실수로 설정을 숨겨 사용자가 복구에서 잠기는 일이 없습니다.

## 다른 인터페이스 흉내내기

레벨이 서로 분리되어 있으므로 테마는 완전히 다른 인터페이스 패러다임을
흉내낼 수 있습니다.

- 콘솔 스타일 테마는 토큰과 스킨을 바꿔 레일, 패널, 버튼을 게임
  UI처럼 보이게 합니다.
- 비주얼 노벨 테마는 채팅 로직이 온전한 채로 채팅 뷰포트, 메시지,
  캐릭터 헤더를 다시 스타일링합니다.
- 모바일 앱 테마는 선언적 셸 레이아웃으로 레일과 패널을
  재정렬합니다.

이 중 어느 것도 채팅 로직, 데이터, 플러그인 동작을 건드릴 필요가
없으며, 그래서 테마 표면을 통째로 교체할 수 있습니다. v1이 제공하지
않는 한 가지는 셸 영역의 자유 형식 재배치입니다. 슬롯은 스타일링되고
채워지지만 이동되지는 않습니다. 범위는 [셸 계약](shell-contract.md)을
참조하세요.
