---
title: 셸 계약
description: 테마가 스타일링하고 플러그인이 채우는 명명된 셸 영역.
sidebar_position: 5
---

셸 계약은 애플리케이션의 명명된 영역을 정의합니다. 테마는 이 영역을
스타일링하고, 플러그인은 안정적인 슬롯을 통해 여기에 콘텐츠를
추가합니다.

## 명명된 셸 영역

호스트는 각 주요 영역을 안정적인 슬롯 속성으로 게시합니다.

| 슬롯                 | 영역                                     |
| -------------------- | ---------------------------------------- |
| `app.shell`          | 애플리케이션 셸 루트                     |
| `navigation.primary` | 내비게이션 레일                          |
| `chat.header`        | 채팅 헤더                                |
| `chat.viewport`      | 채팅 스크롤 뷰포트                       |
| `chat.composer`      | 메시지 입력창                            |
| `character.browser`  | 캐릭터 브라우저 루트                     |
| `panel.left`         | 왼쪽 컨텍스트 패널                       |
| `status.area`        | 연결 상태 영역                           |
| `modal.layer`        | 모달 레이어(시스템 표면 아래의 플러그인) |
| `notification.layer` | 알림 레이어                              |

두 개의 슬롯은 예약되어 있지만 v1의 일부가 아닙니다. `navigation.secondary`
및 `panel.right`입니다.

## 계약이 허용하는 것

테마는 다음을 할 수 있습니다.

- `data-slot` 속성과 그 안의 컴포넌트 훅을 통해 **명명된 영역을
  스타일링**합니다.
- 매니페스트의 선언적 `shellLayout`으로 **주요 영역을
  배치**합니다. 현재는 내비게이션 레일 순서(`main` 및 `bottom`
  그룹)와 관리 탭의 배치(`pinned`)입니다.
- `chat-wallpaper-*` 토큰으로 **채팅 캔버스 배경을 교체**합니다.

영역의 자유 형식 재배치 — 예를 들어 레일을 오른쪽으로 옮기는 것 —
은 v1의 일부가 아닙니다. 슬롯은 스타일링되고 채워지지만
재배치되지는 않습니다.

## 플러그인이 콘텐츠를 추가하는 방식

플러그인은 SDK 등록 API를 받고 호스트가 그 콘텐츠를 안정적인 슬롯에
배치합니다. 예를 들어 `slot: 'left'`로 등록된 사이드바 패널은
`panel.left` 안에 렌더링되고, 플러그인 대화상자는 시스템 표면 아래의
`modal.layer` 안에 쌓입니다.

이 구분에서 따르는 계약은 다음과 같습니다.

- 테마는 플러그인의 내부 DOM에 의존하지 않습니다.
- 플러그인은 내부 React 계층이나 특정 생성된 클래스 이름에 의존하지
  않습니다.
- 양쪽은 명명된 슬롯과 훅 속성에서만 만납니다.

## 영역 안의 안정적인 훅

영역 안에서 컴포넌트는 표준 훅 속성을 게시합니다. 주목할 만한
예시입니다.

- 입력창 루트는 툴바 부분, 필드 부분, `data-component="textarea"`
  입력이 있는 `data-slot="chat.composer"`를 게시합니다.
- 버튼은 `data-part="icon"`과 `data-part="label"`이 있는
  `data-component="button"`을 게시하며, 관련 작업은 기본 및 보조
  그룹이 있는 작업 표시줄(`data-component="action-bar"`)에
  있습니다.
- 탭은 `list`, `trigger`, `content` 부분이 있는
  `data-component="tabs"`를 게시하며, 관리 패널은 세그먼트 변형을
  사용합니다.
- 메시지는 `data-role="user|assistant|system|tool"`과 `streaming` 같은
  상태가 있는 `data-component="chat-message"`를 게시합니다.
- 내비게이션 레일은 항목별로 `data-part="main-items"`,
  `data-part="bottom-items"`, `data-item="<id>"`와
  `data-state="expanded|collapsed"`가 있는
  `data-component="navigation-rail"`을 게시합니다.
- 모든 레일 패널은 하나의 헤더 크롬
  (`data-component="sidebar-panel-header"`)을 공유하므로 테마가 한
  번에 스타일링합니다.

## 레이아웃 책임

호스트는 동작에 중요한 레이아웃을 소유합니다. 포커스 트래핑, 논리적
RTL 방향, 세이프 영역 여백, 최소 대화형 대상 크기입니다. 셸 테마는
영역의 모양과 배치를 바꿀 수 있지만, 문서화된 DOM 순서, 작업 목록의
가로 스크롤, 키보드 동작은 보존해야 합니다. 중단점은 SDK에 등록되어
있으며(뷰포트 너비 px용 `VIEWPORT_BREAKPOINTS`, 컨테이너 크기 rem용
`CONTAINER_BREAKPOINTS`), `prefers-reduced-motion` 같은 기능 쿼리는
레이아웃 중단점이 아닙니다.

이 영역을 스타일링하는 레이어는 [컴포넌트 스킨](component-skin.md),
셸이 망가졌을 때의 복구는 [세이프 모드](safe-mode.md)를 참조하세요.
