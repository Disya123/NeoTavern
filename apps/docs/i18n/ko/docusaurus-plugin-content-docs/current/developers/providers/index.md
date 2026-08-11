---
title: 프로바이더 개요
description: NeoTavern이 하나의 어댑터 계약으로 LLM, TTS, STT, 이미지 서비스와 통신하는 방식.
sidebar_position: 1
---

프로바이더는 NeoTavern이 외부 AI 서비스와 통신하는 방식입니다. 언어
모델, 텍스트 음성 변환, 음성 텍스트 변환, 이미지 생성이 여기
해당합니다.

## 하나의 어댑터 계약

모든 프로바이더 — OpenAI 호환 채팅 엔드포인트든, 네이티브 Anthropic
연결이든, NovelAI나 KoboldAI 같은 커뮤니티 백엔드든, 플러그인 등록
서비스든 — `@neotavern/provider-sdk`의 같은 `ProviderAdapter` 계약을
구현합니다. 핵심 파이프라인은 이 계약만 알므로 애플리케이션은 어떤
단일 벤더에도 묶이지 않습니다.

어댑터는 다음을 지원해야 합니다.

- 구성 검증.
- 사용 가능한 모델 나열.
- `AbortSignal`을 통한 취소.
- 통합 생성 이벤트 스트림.
- 정규화된 오류.
- 타임아웃.
- 비밀이 없는 로깅.
- Plugin SDK를 통한 등록.

파이프라인은 벤더와 무관하게 하나의 형태를 보므로 스트리밍, 컨텍스트
시프팅, 오류 처리가 모든 프로바이더에서 동일하게 작동합니다. 정확한
요구 사항은 [어댑터 계약](adapter-contract.md)을 참조하세요.

## 기본 제공 어댑터

배포판에는 OpenAI 호환 엔드포인트, Anthropic, 텍스트 완성
엔드포인트, NovelAI, KoboldAI, AI Horde, 로컬 echo 어댑터가
포함됩니다. 각각은 [어댑터](adapters.md)에 문서화되어 있습니다.

## 로컬 토큰 추정

토큰 계산은 로컬 및 오프라인입니다. 정확한 토크나이저(tiktoken,
SentencePiece, Hugging Face 토크나이저 JSON)를 모델별로 등록할 수
있으며 프로바이더 플러그인도 가능합니다. 정확한 토크나이저가 등록될
때까지 호스트는 스크립트를 인식하는 휴리스틱을 사용하고 개수를 근사로
표시합니다.

## 프로바이더 확장

코어는 의도적으로 벤더 SDK 의존성이 없습니다. 새 프로바이더는
어댑터를 작성하고 등록하여 추가합니다.

- 코어 프로바이더는 `@neotavern/provider-sdk`의 `ProviderRegistry`를 통해
  등록합니다.
- 플러그인 프로바이더는 Plugin SDK의 백엔드 API
  (`api.providers.register(kind, factory)`)를 통해 등록하며,
  `providers.register` 권한이 필요합니다. 등록은 정리 함수를
  반환하고 플러그인이 비활성화되면 자동으로 제거됩니다.

이것이 비공개 엔드포인트, 자체 호스팅 모델, 기본 제공 어댑터가 없는
서비스의 문서화된 경로입니다. 생성된 [Provider SDK
레퍼런스](../api/provider-sdk/)는 전체 계약을 문서화합니다.
