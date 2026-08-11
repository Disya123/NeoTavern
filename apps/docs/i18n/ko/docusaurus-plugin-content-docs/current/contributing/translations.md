---
title: 번역
description: NeoTavern 문서 사이트 번역에 기여하거나 기존 번역을 개선하는 방법
sidebar_position: 5
---

문서 사이트는 영어와 여덟 개 로케일로 제공되며, 모든 번역은 커뮤니티
기여입니다. 이 페이지는 번역에 기여하거나 기존 번역을 고치는 방법을
설명합니다.

## 현재 로케일

기본 언어는 영어입니다. 번역 로케일은 러시아어(`ru`), 중국어 간체
(`zh-Hans`), 일본어(`ja`), 한국어(`ko`), 스페인어(`es`), 프랑스어
(`fr`), 독일어(`de`), 브라질 포르투갈어(`pt-BR`)입니다.

## 번역이 있는 위치

각 로케일은 `apps/docs/i18n/` 아래에 영어 트리를 미러링합니다.

```
apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/<path>.md
```

UI 문자열 — 내비게이션 바, 푸터, 태그라인, 사이드바 레이블 — 은
`apps/docs/i18n/<locale>/docusaurus-theme-classic/` 아래의 JSON 파일에
있으며 write-translations 명령어로 생성됩니다.

## 완전성

모든 영어 페이지는 같은 상대 경로에 번역 대응이 있어야 합니다.
번역되지 않은 페이지는 자동으로 영어로 폴백되므로 부분 진행도 즉시
보입니다. 하지만 전체 커버리지를 목표로 하고 반쯤 번역된 파일을 절대
제출하지 마세요.

## 번역할 것

- 제목, 본문, 캡션, 대체 텍스트.
- 프런트 매터 `title`과 `description`. `sidebar_position`은 동일하게
  유지하세요.
- `_category_.json` 레이블.

## 그대로 둘 것

- 링크, 코드 펜스, 인라인 코드, 어드모니션 구문(`:::note` ... `:::`),
  바이트 단위로.
- 제품 이름: NeoTavern은 절대 번역되지 않습니다.
- API 식별자, 파일 이름, 명령어, 플래그는 영어 형태를 유지합니다.

## 용어

앱 자체의 UI 표현이 있으면 그것을 사용하고, 없으면 언어의 표준
커뮤니티 용어를 사용하세요. 표준 커뮤니티 용어가 이미 존재하면 그것을
선호하며 새 단어를 만들지 마세요.

## 번역 고치기

로케일의 같은 상대 경로 파일을 편집하고 풀 리퀘스트를 여세요. 페이지의
영어 원본이 바뀌면 같은 변경에서 그 페이지의 번역도 업데이트하세요.

## 새 로케일 추가

1. `apps/docs/docusaurus.config.ts`의 `i18n.locales`와 `localeConfigs`에
   로케일 코드와 표시 레이블을 추가합니다.
2. 로케일 폴더를 생성합니다.

   ```bash
   pnpm docs:translations -- --locale <code>
   ```

3. `apps/docs/i18n/<locale>/docusaurus-plugin-content-docs/current/`
   아래의 모든 페이지와 생성된 JSON 파일을 번역합니다.
4. 구성 변경과 새 파일이 모두 포함된 풀 리퀘스트를 엽니다.

로케일 코드는 표준 관례를 따릅니다. 예: 중국어 간체는 `zh-Hans`,
브라질 포르투갈어는 `pt-BR`.
