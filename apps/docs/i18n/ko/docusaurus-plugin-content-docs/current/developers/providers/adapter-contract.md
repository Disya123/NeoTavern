---
title: 어댑터 계약
description: 모든 프로바이더 어댑터가 검증부터 타임아웃까지 구현해야 하는 것.
sidebar_position: 2
---

어댑터 계약은 모든 LLM, TTS, STT, 이미지 프로바이더가 구현하는
계약입니다. 이를 충족하는 어댑터를 작성하면 전체 파이프라인이 내
프로바이더와 함께 동작합니다.

## 인터페이스

`ProviderAdapter` 인터페이스는 안정적인 `kind`, 선택적인 모달리티
선언, 필수 메서드를 가집니다. 텍스트 생성이 기본 능력이며, 음성,
이미지, 전사 메서드는 선택적이므로 LLM 전용 어댑터도 유효한
프로바이더입니다.

```ts
interface ProviderAdapter {
  readonly kind: string;
  readonly modalities?: readonly ProviderModality[];
  readonly capabilities?: {
    assistantPrefill?: boolean;
    textCompletion?: boolean;
  };
  validateConfig(): Promise<ValidationResult>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  speech?(request: SpeechRequest, signal: AbortSignal): AsyncIterable<SpeechEvent>;
  image?(request: ImageRequest, signal: AbortSignal): AsyncIterable<ImageEvent>;
  transcribe?(request: TranscriptionRequest, signal: AbortSignal): Promise<TranscriptionResult>;
  countTokens?(request: TokenCountRequest): Promise<TokenCount>;
}
```

## 필수 동작

계약은 여덟 가지 동작을 요구합니다.

- **구성 검증** — `validateConfig()`는 네트워크 호출 없이 어댑터
  자신의 구성을 검사하고 문제 목록을 반환합니다.
- **모델 나열** — `listModels(signal)`은 사용 가능한 모델을
  반환하며 중단 신호를 존중해야 합니다.
- **취소** — 모든 장기 실행 메서드는 `AbortSignal`을 받고 신호가
  발생하면 신속히 중단해야 합니다.
- **통합 이벤트 스트림** — `generate()`는 타입이 있는
  `GenerationEvent` 스트림을 만들고 정확히 하나의 종료 이벤트인
  `done` 또는 `error`로 끝나야 합니다. 음성과 이미지 생성도 같은
  스트리밍 형태를 사용합니다.
- **오류 정규화** — 프로바이더 실패는 기계가 읽을 수 있는 코드와
  매개변수가 있는 안정적인 `AppError` 코드로 매핑됩니다. 업스트림
  HTTP 상태가 구분되며(인증, 비율 제한, 잘못된 모델, 서버 오류), 원시
  업스트림 본문은 클라이언트로 전달되지 않습니다.
- **타임아웃** — 어댑터는 호출자의 신호에만 의존해서는 안 됩니다.
  연결, 유휴 스트리밍 침묵, 전체 응답 읽기를 위한 자체 마감이
  필요합니다. SDK는 `ProviderTimeouts`(기본값: 연결 30초, 유휴 60초,
  읽기 30초)와 호출자 신호를 재설정 가능한 마감과 결합하고 `TIMEOUT`
  오류로 중단하는 `DeadlineController`를 제공합니다.
- **안전한 로깅** — API 키는 안전한 저장소에서 제공되며 절대
  로깅되거나 진단, 오류 출력에 포함되어서는 안 됩니다.
- **등록** — 어댑터는 코어 레지스트리 또는 Plugin SDK 백엔드 API를
  통해 종류별로 등록됩니다.

## 벤더 중립성

코어는 어떤 벤더 SDK에도 묶이지 않습니다. 새 어댑터는 전역 `fetch`와
SDK의 SSE 파서(`parseSseStream`)를 사용해 스트리밍 응답을 처리할
것으로 기대됩니다.

문서화된 예외가 정확히 하나 있습니다. Anthropic 어댑터는
`@anthropic-ai/sdk`를 사용합니다. Anthropic API — 확장 사고와 베타
헤더 지원 — 가 손으로 작성한 fetch 클라이언트보다 공식 SDK로 더
정확하게 처리되기 때문입니다. 벤더 라이브러리에 연결된 유일한
어댑터이며, 나머지는 모두 HTTP를 직접 사용합니다.

## 호스트 통합

`ProviderRegistry`는 프로바이더 종류를 어댑터 팩토리로 매핑합니다.
`register`는 등록 해제 함수를 반환하고, `create`는 어댑터를
인스턴스화하며 알 수 없는 종류에 `PROVIDER_NOT_FOUND`를 던지고,
레지스트리는 로컬 토크나이저 레지스트리도 호스팅합니다.
`assistantPrefill` 같은 선언된 와이어 능력은 연결 프로필을 검증하는
데 사용됩니다. 호스트가 어댑터가 지원하지 않는 영속 프로필 오버라이드를
조용히 버리지 않습니다.

실제 기본 제공 어댑터와 각각이 대상으로 하는 것은
[어댑터](adapters.md), 플러그인에서 어댑터를 등록하는 방법은 [Plugin
SDK 백엔드 API](../plugin-sdk/backend.md)를 참조하세요.
