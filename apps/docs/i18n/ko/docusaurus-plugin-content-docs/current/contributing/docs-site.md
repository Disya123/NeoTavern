---
title: 문서 사이트
description: NeoTavern 문서 사이트가 동작하는 방식과 페이지를 추가하거나 수정하는 방법
sidebar_position: 4
---

공개 문서 사이트는 `apps/docs`의 Docusaurus 프로젝트입니다. 이
페이지는 구조와 페이지 추가/업데이트 방법을 설명합니다.

## 구조

- 영어 원본 페이지는 `apps/docs/docs/`에 있으며, 사이드바가 보여주는
  것과 같은 디렉터리로 페이지당 하나의 마크다운 파일로 구성됩니다.
- 번역은
  `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`에
  있으며 영어 트리를 페이지당 하나의 파일로 미러링합니다.
  [번역](./translations)을 참조하세요.
- `apps/docs/docs/api/` 아래의 SDK 레퍼런스는 생성되며 gitignore됩니다.
  손으로 편집하지 마세요.

## 페이지 추가

1. 페이지가 나타나야 하는 디렉터리에 마크다운 파일을 만듭니다.
2. `title`, `description`, `sidebar_position`이 있는 프런트 매터를
   추가합니다.

   ```yaml
   ---
   title: Page Title
   description: One sentence describing the page.
   sidebar_position: 3
   ---
   ```

3. 페이지가 다루는 내용의 한 문장 요약으로 시작합니다.
4. 섹션에는 `##`과 `###`을 사용합니다. 프런트 매터 `title`이 단일
   H1을 제공합니다.
5. 새 디렉터리를 추가하면 그 안에 `_category_.json`을 만듭니다.

   ```json
   { "label": "Category Label", "position": 2 }
   ```

`sidebar_position`은 디렉터리 안의 페이지 순서를 정하며 Overview
페이지가 1입니다. 콘텐츠 사이드바 섹션은 디렉터리 구조에서
자동 생성됩니다.

## MDX 제한

페이지는 일반 Markdown에 Docusaurus 어드모니션만 더한 것입니다.

```md
:::note
Text inside the admonition.
:::
```

`import` 문, 사용자 지정 JSX 컴포넌트, 탭, 원시 HTML이 없습니다. 모든
페이지는 여덟 개 번역 로케일 어디에든 그대로 복사할 수 있어야
합니다. 코드 샘플은 언어 태그가 있는 펜스 블록을 사용합니다.

## SDK 레퍼런스

SDK 레퍼런스는 TypeDoc이 각 패키지의 진입점에서 생성합니다.

- `packages/plugin-sdk/src/index.ts` -> `apps/docs/docs/api/plugin-sdk/`
- `packages/theme-sdk/src/index.ts` -> `apps/docs/docs/api/theme-sdk/`
- `packages/provider-sdk/src/index.ts` -> `apps/docs/docs/api/provider-sdk/`
- `packages/contracts/src/index.ts` -> `apps/docs/docs/api/contracts/`

레퍼런스는 모든 사이트 빌드에서 재생성되므로 생성된 페이지의 편집은
사라집니다. 레퍼런스 페이지를 고치려면 패키지 소스의 TSDoc을 고치세요.
`apps/docs/docs/api/index.md`의 개요는 손으로 작성되며 커밋된 채
유지됩니다.

## 사이트 실행

```bash
pnpm docs:site        # local dev server with hot reload
pnpm docs:site:build  # production build: all locales plus the SDK reference
```

프로덕션 빌드가 게이트입니다. 끊어진 링크와 끊어진 마크다운 링크가
빌드를 실패시키므로 콘텐츠 변경을 푸시하기 전에 실행하세요.

## 링크 규칙

내부 링크는 사이트에 존재하는 페이지를 가리켜야 합니다. 홈
페이지에서는 절대 사이트 경로(`/getting-started/`), 더 깊은
페이지에서는 상대 경로(`contributing/` 아래 페이지의 `../developers/`)
를 선호하세요. 외부 링크는 Docusaurus 문서와 NeoTavern 저장소로
제한됩니다.

## 내부 개발자 문서

저장소는 또한 `docs/`의 리포 루트에 내부 개발자 문서를 유지하며,
`pnpm docs:check`와 `pnpm docs:build`로 검증합니다. 그것은 이 공개
사이트와 별개의 문서 집합입니다. 두 트리를 혼동하지 마세요.
