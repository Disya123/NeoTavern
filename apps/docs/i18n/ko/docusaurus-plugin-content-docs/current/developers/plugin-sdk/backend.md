---
title: 백엔드 플러그인 API
description: 백엔드 플러그인이 받는 제한된 서버 측 추상화.
sidebar_position: 5
---

백엔드 API는 서버 측 플러그인이 `activate()` 호출에서 받는
것입니다. 라우트, 스토리지, 이벤트, 로깅, 네트워크 접근, 프로바이더,
파일을 위한 제한된 추상화이며, 그 외에는 없습니다.

## 진입점

백엔드 플러그인은 `ServerPluginApi` 객체를 받는 `activate(api)`
함수가 있는 정의를 내보냅니다.

```ts
import { definePlugin } from '@neotavern/plugin-sdk';

export default definePlugin({
  activate(api) {
    const off = api.routes.get('/hello', async (request) => ({
      status: 200,
      body: { hello: 'world' },
    }));
  },
});
```

백엔드 진입점은 별도의 Node.js 프로세스로 실행됩니다. 플러그인은
Fastify 루트 인스턴스, SQLite 연결, 내부 테이블, 절대 경로, 전체
환경, 다른 프로바이더의 API 키를 절대 받지 않습니다.

## 라우트

`api.routes`는 `/api/plugins/{pluginId}/` 아래에 마운트되는 범위가 있는
라우터입니다. 각 메서드는 경로와 핸들러를 받고 정리 함수를
반환합니다.

- `api.routes.get(path, handler)`
- `api.routes.post(path, handler)`
- `api.routes.put(path, handler)`
- `api.routes.delete(path, handler)`

`PluginRequest`는 `params`, `query`, `headers`, 파싱된 JSON `body`,
`AbortSignal`을 담습니다. `PluginResponse`는 `{ status, body, headers }`
입니다. 핸들러는 값을 직접 또는 프로미스로 반환할 수 있으며, 호스트는
타임아웃을 강제하고 신호로 작업을 취소합니다.

## 스토리지

`api.storage`는 플러그인별로 격리된 네임스페이스 키/값 저장소입니다.

```ts
await api.storage.set('state', { count: 1 });
const state = await api.storage.get('state');
await api.storage.delete('state');
const keys = await api.storage.keys();
```

데이터는 플러그인 ID로 범위가 지정되므로 두 플러그인이 절대 충돌하지
않습니다.

## 이벤트와 로깅

`api.events`는 프론트엔드가 사용하는 것과 같은 타입이 있는 이벤트
버스입니다. 구독은 구독 해제 함수를 반환하며, 모든 구독은 비활성화,
크래시, 종료 시 자동으로 제거됩니다. 내보내기는 자체 네임스페이스
(`{pluginId}.event`)로 제한되고, 페이로드는 JSON에 안전해야 하며,
호스트는 페이로드 크기와 런타임당 이벤트 이름 수를 제한합니다.

`api.logger`는 `debug`, `info`, `warn`, `error` 메서드를 제공하며 각각
메시지와 선택적 메타데이터를 받습니다. 로그에 비밀이 포함되지
않습니다.

## 권한 검사된 fetch

`api.fetch`는 플러그인의 `network:<host>` 권한으로 보호되는
`fetch`입니다.

```ts
const response = await api.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Accept: 'application/json' },
  signal,
});
```

부여되지 않은 호스트에 대한 요청은 네트워크 활동 전에 거부됩니다.
다른 프로바이더의 비밀은 요청에 절대 주입되지 않습니다. 응답 객체는
`ok`, `status`, `text()`, `json()`을 노출합니다.

## 프로바이더와 컨텍스트 전략

`api.providers`로 플러그인이 생성을 확장할 수 있습니다.

- `api.providers.register(kind, factory, options)`가 새 프로바이더
  어댑터 종류를 등록합니다(`providers.register` 필요). 등록은 정리
  함수를 반환합니다.
- `api.providers.registerTokenizer(profile)`이 로컬 모델별 토크나이저를
  등록합니다. 프로필은 `id`, `approximate`, `matches(model)`,
  `count(text)`를 선언합니다. 정확한 토크나이저는 tiktoken,
  SentencePiece, Hugging Face 토크나이저 JSON으로 만들 수 있으며,
  모델용으로 등록될 때까지 호스트는 스크립트를 인식하는 휴리스틱으로
  폴백하고 개수를 근사로 표시합니다. 등록은 비활성화 시 자동으로
  제거됩니다.

`api.contextStrategies.register(strategy)`는 컨텍스트 시프팅 전략을
추가합니다. 호스트는 시스템, 고정, 현재 사용자 블록이 살아남는지
검증하고 최종 토큰 예산을 스스로 적용합니다. 전략이 반환하는
`fitsBudget` 값은 신뢰되지 않습니다.

`api.postProcessors.register(processor)`는 생성 후 훅을 추가합니다.
스트림 완료 후, 메시지 저장 전에 실행되며 새 문자열을 반환하면
어시스턴트 응답을 교체합니다. `prompt.modify`가 필요합니다.

## 가상 파일 시스템

`api.files`는 플러그인 자체 데이터 디렉터리를 루트로 하는 샌드박스
가상 파일 시스템입니다.

```ts
await api.files.write('notes.txt', 'content');
const content = await api.files.read('notes.txt');
const entries = await api.files.list('.');
await api.files.delete('notes.txt');
```

경로는 플러그인 루트를 벗어날 수 없으므로 플러그인은 자기 데이터만
다룰 수 있습니다.

## 백엔드 플러그인이 할 수 없는 것

API 표면은 의도적으로 작습니다. 호스트 데이터베이스, 다른 플러그인의
스토리지, 임의 파일 시스템 경로, 검증되지 않은 네트워크 호스트에
도달할 방법이 없습니다. SDK가 노출하지 않으면 접근할 수 없습니다.
생성된 [Plugin SDK 레퍼런스](../../api/plugin-sdk/)는 전체
`ServerPluginApi` 표면을 나열하고, [프로바이더](../providers/index.md)는
프로바이더 플러그인이 모델에 어떻게 맞는지 설명합니다.
