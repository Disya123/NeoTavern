---
title: 플러그인 매니페스트
description: 모든 .stplugin 패키지가 포함해야 하는 plugin.json 스키마.
sidebar_position: 2
---

플러그인 매니페스트(`plugin.json`)는 플러그인의 단일 진실 공급원입니다.
정체성, 진입점, 요청된 권한, 선언된 능력이 여기 있습니다.

## 패키지 구조

`.stplugin` 패키지는 루트에 `plugin.json`, 참조하는 진입 파일, 에셋이
있는 ZIP 아카이브입니다. 호스트는 아무것도 설치하기 전에 아카이브를
검증합니다. 경로 탐색, 심볼릭 링크, 실행 가능 페이로드, 크기 제한이
모두 거부됩니다.

## 매니페스트 필드

```json
{
  "id": "author.plugin-name",
  "name": "Plugin Name",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "neotavern": "^0.1.0" },
  "frontend": "dist/frontend.js",
  "backend": "dist/backend.mjs",
  "styles": "dist/plugin.css",
  "permissions": ["chat.read", "ui.messageActions", "network:api.example.com"],
  "i18n": { "ru": "locales/ru.json", "de": "locales/de.json" }
}
```

핵심 필드는 다음과 같습니다.

- **`id`** — 역 DNS 형식 식별자, 예: `author.plugin-name`. 설치된 모든
  플러그인에서 고유하며 업데이트를 가로질러 안정적입니다.
- **`name`** — 플러그인 관리자에 표시되는 사람이 읽을 수 있는 이름.
- **`version`** — 시맨틱 버전(`major.minor.patch`). 버전 비교와 캐시
  버스팅에 사용됩니다.
- **`apiVersion`** — 플러그인이 대상으로 하는 SDK API 버전. 현재
  버전은 3이며, 새 런타임이 프로덕션에 도입될 때까지 버전 2가
  기본값으로 유지됩니다.
- **`engines`** — `neotavern: "^0.1.0"` 같은 호환성 제약.
- **`frontend`** — 브라우저 ESM 진입점의 상대 경로.
- **`backend`** — Node.js ESM 진입점의 상대 경로.
- **`styles`** — 선택적인 플러그인 스타일시트.
- **`i18n`** — 로케일 코드에서 번역 JSON 파일의 상대 경로로.

## 권한

`permissions` 배열은 SDK v2의 레거시 평면 목록입니다. 새 매니페스트는
대신 `requiredCapabilities`와 `optionalCapabilities`를 통해 범위가 있는
능력을 선언해야 합니다.

```json
{
  "requiredCapabilities": [
    { "name": "chat.read" },
    { "name": "network", "scope": "api.example.com" }
  ],
  "optionalCapabilities": [{ "name": "lorebook.read" }]
}
```

`requiredCapabilities`는 플러그인이 없이는 작동할 수 없는 능력이고,
`optionalCapabilities`는 없어도 기능이 저하될 뿐인 능력입니다. 사용자는
설치 시 요청된 모든 능력을 확인합니다. 업데이트에서 새 권한을 추가하면
재동의가 필요합니다. [권한](permissions.md)을 참조하세요.

## 레거시 진입점

```json
{
  "legacy": {
    "frontend": "legacy/main-window.js",
    "backend": "legacy/server.mjs"
  }
}
```

`legacy` 블록은 기존 SillyTavern 확장 기능을 위한 신뢰할 수 있는 호환
진입점을 가리킵니다. 두 진입점 중 하나를 사용하는 패키지는
`legacy.trusted` 권한을 요청해야 하며, UI는 동의 중 더 강한 경고를
보여줍니다. 세이프 모드는 레거시 진입점을 절대 로드하지 않습니다.
네이티브 플러그인과 어떻게 다른지는 [샌드박싱](sandboxing.md)을
참조하세요.

## OAuth 클라이언트

외부 서비스에 연결하는 플러그인은 PKCE가 있는 인증 코드 흐름을 사용해
공개 OAuth 2.0 클라이언트를 선언할 수 있습니다.

```json
{
  "authClients": [
    {
      "serviceId": "com.example.idp",
      "name": "Example IdP",
      "authorizationUrl": "https://idp.example.com/oauth/authorize",
      "tokenUrl": "https://idp.example.com/oauth/token",
      "clientId": "neotavern-author.plugin-name",
      "scopes": ["profile.read"]
    }
  ]
}
```

공개 클라이언트만 허용됩니다. `clientSecret`은 플러그인 코드가
샌드박스에서 실행되므로 금지됩니다. 엔드포인트는 HTTPS여야 하며, 개발
중 로컬 ID 공급자를 위한 일반 HTTP 루프백 예외가 있습니다. 디스크립터를
변경하려면 패키지를 다시 설치해야 합니다.

## 워커 및 서명 필드

고급 매니페스트는 추가 모듈을 선언할 수 있습니다.

- **`workers`** — 플러그인이 격리된 계산 워커로 실행할 수 있는
  패키지 상대 진입 모듈. 선언되지 않은 진입점을 실행하면
  거부됩니다.
- **`publisher`** 및 **`signature`** — 패키지 서명. `keyId`는 서명
  공개 키의 `ed25519:<hex>` 지문이고, `signature`는 정규 매니페스트에
  대한 base64 Ed25519 서명입니다. 이 값들은 플러그인 빌드 도구가
  설정하며 손으로 작성하지 않습니다.

SDK의 `validateManifest` 함수가 모든 필드를 검사하며, 생성된 [Plugin
SDK 레퍼런스](../../api/plugin-sdk/)는 정확한 `PluginManifest` 타입을
문서화합니다.
