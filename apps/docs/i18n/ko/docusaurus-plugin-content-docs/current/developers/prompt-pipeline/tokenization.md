---
title: 토큰화
description: >-
  토크나이저 레지스트리를 통한 로컬 토큰 계산: tiktoken 호환,
  SentencePiece, Hugging Face JSON, 모델별 플러그인, 근사 폴백.
sidebar_position: 4
---

토큰 계산은 tiktoken 호환, SentencePiece, Hugging Face JSON, 모델별
플러그인 토크나이저를 지원하는 토크나이저 레지스트리를 통해 로컬에서
실행되며, 명시적인 근사 폴백이 있습니다.

## 로컬 계산

토큰 계산은 기기를 떠나지 않습니다. 레지스트리는 활성 모델에 맞는
토크나이저 프로필을 선택하고, 파이프라인은 네트워크 요청 전에 조립된
컨텍스트를 프로세스 내에서 계산합니다.

## 토크나이저 레지스트리

레지스트리는 네 종류의 토크나이저를 받습니다.

- **tiktoken 호환** — OpenAI 모델 계열용, OpenAI tiktoken과 호환되는
  BPE 토크나이저.
- **SentencePiece** — SentencePiece 어휘를 제공하는 모델.
- **Hugging Face 토크나이저 JSON** — Hugging Face 저장소의
  `tokenizer.json` 파일을 압축된 순위 형식으로 변환한 것.
- **모델별 플러그인** — 프로바이더 플러그인이 모델에 정밀한
  토크나이저 프로필을 등록할 수 있습니다.

등록된 토크나이저가 없는 모델을 위한 **근사 폴백**이 있으며, 항상
명시적으로 표시되므로 UI는 추정치를 정확한 수치로 제시하지
않습니다.

## 기본 제공 프로필

코어는 일반적인 계열에 대한 오프라인 프로필을 등록합니다.

- `openai:o200k_base` — GPT-4o, GPT-4.1, GPT-5, o1, o3, o4 계열.
- `openai:cl100k_base` — GPT-4, GPT-3.5 Turbo, text-embedding-3 계열.
- `deepseek:bytelevel-bpe-v1` — DeepSeek 계열. 계산은 공식
  `tokenizer.json`의 순위 위에서 압축된 계산 전용 엔진(어휘와 디코더가
  없는 BPE 병합 포트)을 통해 실행됩니다. 파일은 원자적
  temp-plus-rename 쓰기로 `data/cache/tokenizers/deepseek-v4-flash/`에
  캐시되는 작은 순위 파일로 한 번 변환되며, 전체 JSON과 런타임
  토크나이저 라이브러리는 저장되지도 로드되지도 않습니다.

네트워크를 사용할 수 없으면 DeepSeek 프로필은 정직하게 근사 프로필로
폴백하고 15분에 최대 한 번 재시도합니다. 토크나이저가 없어도 생성이
막히지 않습니다.

## 근사 폴백

알 수 없는 로컬 모델은 `approximate-character-v1`을 사용합니다.
스크립트를 인식하는 휴리스틱으로, 라틴 문자는 토큰당 약 4.6자, 키릴
문자는 4.0자, CJK는 1.7자, 숫자는 2.0자입니다. 근사치는 나타나는 모든
곳에서 표시되며, 프로바이더 플러그인이 정밀한 프로필을 등록하면 언제든
교체할 수 있습니다.

## 플러그인 프로필

플러그인은 우선순위와 함께 토크나이저 프로필을 등록합니다. `-10`보다
높은 우선순위의 플러그인 프로필은 다루는 모델에서 계열 프로필을
오버라이드합니다. 선택된 프로필은 `countTokens`, `tokenizerProfile`,
`tokenizerApproximate`로 파이프라인에 전달됩니다.

## 토큰 예산 결과

계산 후 파이프라인은 `PipelineResult.tokenBudget`을 노출하며, 여기에는
다음이 포함됩니다.

- 사용된 토크나이저 프로필;
- `approximate` 플래그;
- 모델의 컨텍스트 한도;
- 예약된 응답 공간;
- 최종 프롬프트 토큰 수.

예산이 강제되는 방식은 [컨텍스트 시프팅](context-shifting)을
참조하세요.
