---
title: 기본 제공 어댑터
description: NeoTavern과 함께 제공되는 프로바이더 어댑터와 각각이 대상으로 하는 것.
sidebar_position: 3
---

NeoTavern은 기본 제공 프로바이더 어댑터 세트와 함께 제공됩니다.
어댑터는 `packages/provider-sdk/src/adapters/`에 파일당 하나씩 있으며,
프로바이더 종류별로 코어 `ProviderRegistry`에 등록됩니다.

## OpenAI 호환

파일: `openaiCompatible.ts` — 종류 `openai-compatible`.

OpenAI `/v1/chat/completions` 및 `/v1/models` API를 노출하는 모든
서버를 대상으로 합니다. OpenAI 자체, OpenRouter, LM Studio, llama.cpp
서버, `/v1` 엔드포인트가 있는 Ollama, vLLM 등입니다. 전역 `fetch`와
SDK의 SSE 파서만 사용하며, API 키는 전송되지만 절대 로깅되지
않습니다.

## Anthropic

파일: `anthropic.ts` — 종류 `anthropic`.

네이티브 Anthropic Messages API를 대상으로 합니다. no-vendor-SDK
규칙의 문서화된 단일 예외입니다. API — 확장 사고와 베타 헤더 지원 —
가 공식 SDK로 더 정확하게 처리되므로 `@anthropic-ai/sdk`를
사용합니다. 프롬프트 캐싱과 적응형 사고를 지원하며 `assistantPrefill`
와이어 능력을 선언합니다.

## 텍스트 완성

파일: `textCompletion.ts` — 종류 `text-completion`.

레거시 OpenAI `/v1/completions` 엔드포인트를 노출하는 로컬 또는 자체
호스팅 백엔드를 대상으로 합니다. text-generation-webui("ooba"),
koboldcpp, vLLM, Ollama, llama.cpp 서버 등입니다. 채팅 어댑터와 달리
직렬화된 프롬프트를 소비합니다. 프롬프트 파이프라인이 인스트럭트
포맷을 렌더링하고 어댑터에게 완성된 프롬프트가 내용인 단일 user
메시지를 넘기며, 어댑터는 이를 `/completions`로 보냅니다. API 키는
로컬 서버에서는 선택 사항이며 절대 로깅되지 않습니다.

## NovelAI

파일: `novelai.ts` — 종류 `novelai`.

NovelAI 텍스트 생성 API(`POST {baseUrl}/ai/generate`, Bearer 키 사용)를
대상으로 합니다. 생성은 비스트리밍이며, 통합 스트림 계약에 맞춰 단일
`delta`와 종료 `done` 이벤트로 구성됩니다. API가 모델 검색을
제공하지 않으므로 `listModels`는 구성된 모델을 반환합니다. NovelAI의
매개변수 표면이 진화하므로 어댑터는 실험적 표시가 붙습니다. 잘
확립된 샘플러만 매핑됩니다.

## KoboldAI

파일: `koboldai.ts` — 종류 `koboldai`.

KoboldAI/Kobold 서버 네이티브 API(`POST {baseUrl}/api/v1/generate`)를
대상으로 합니다. 생성은 비스트리밍이며, 로드된 모델은 검색을 위해
`/api/v1/model`에서 읽습니다. 일반적인 로컬 설치는 API 키가 필요
없습니다.

## AI Horde

파일: `aiHorde.ts` — 종류 `ai-horde`.

비동기 크라우드소싱 클러스터인 AI Horde(`stablehorde.net`)를
대상으로 합니다. 작업은 `/api/v2/generate/text/async`로 제출된 다음
상태 엔드포인트를 통해 완료될 때까지 폴링됩니다. 폴링 루프는 호출자
신호와 유휴 마감을 다시 확인하므로 멈춘 작업이 영원히 폴링하는 대신
중단됩니다. 익명 사용은 낮은 우선순위로 허용되며, 구성되면 API 키가
`apikey` 헤더로 전송됩니다.

## Echo

파일: `echo.ts` — 종류 `echo`.

네트워크나 API 키 없이 테스트, 데모, 스트리밍 파이프라인 검증을 위한
완전 오프라인 프로바이더입니다. 마지막 사용자 메시지를 단어 단위로
다시 스트리밍합니다. 선택적인 음성, 이미지, 전사 메서드도 구현하므로
모든 모달리티를 다루는 어댑터 작성의 유용한 참고 자료입니다.

## 프롬프트 헬퍼

파일: `prompt.ts` — 어댑터가 보내는 프롬프트 형태로 메시지 배열을
직렬화하는 공유 헬퍼 `promptFromMessages`를 내보냅니다. 어댑터
자체는 아닙니다.

이들이 모두 구현하는 정확한 `ProviderAdapter` 인터페이스는 [어댑터
계약](adapter-contract.md)과 생성된 [Provider SDK
레퍼런스](../../api/provider-sdk/)를 참조하세요.
