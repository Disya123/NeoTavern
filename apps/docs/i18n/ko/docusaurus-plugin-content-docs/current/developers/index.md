---
title: 개발자
description: >-
  NeoTavern 개발자 문서 개요: 아키텍처, 프롬프트 파이프라인, 데이터
  계층, 앱 확장용 SDK를 다룹니다.
sidebar_position: 1
---

이 섹션은 NeoTavern이 어떻게 구축되었는지, 그리고 플러그인, 테마,
프로바이더 어댑터로 어떻게 확장할 수 있는지 설명합니다.

## 이 섹션에서 다루는 내용

개발자 문서는 네 그룹으로 나뉩니다.

- **아키텍처** — 모노레포 구조, 승인된 기술 스택, 각 워크스페이스
  패키지의 역할.
- **프롬프트 파이프라인** — 채팅을 프로바이더 요청으로 바꾸는 고정된
  단계 집합. 인스트럭트 포맷, 토큰화, 컨텍스트 시프팅을 포함합니다.
- **데이터 및 저장소** — NeoTavern이 구조화된 데이터를 SQLite에
  저장하는 방식, 파일과 이미지가 디스크에서 처리되는 방식, 백업
  동작 방식.
- **NeoTavern 확장** — Plugin SDK, Theme SDK, 프로바이더 어댑터, 자동
  생성 API 레퍼런스, 데스크톱 셸.

## 어디서 시작할까

코드베이스의 구조를 이해하고 싶다면 [아키텍처 개요](developers/architecture/)부터
시작하고, 생성 동작을 작업한다면 [프롬프트
파이프라인](developers/prompt-pipeline/)으로 바로 가세요.

## 데이터 계층

[데이터 및 저장소](developers/data/) 섹션은 SQLite 데이터베이스, 파일 시스템
구조, 백업 모델을 다룹니다. 데이터를 영속화하는 모든 것의
레퍼런스입니다.

## NeoTavern 확장

NeoTavern은 네 가지 방식으로 확장됩니다.

- [Plugin SDK](developers/plugin-sdk/) — 매니페스트, 권한, 프론트엔드 및 백엔드
  API, 라이프사이클 훅, 샌드박싱이 있는 플러그인.
- [Theme SDK](developers/theme-sdk/) — 디자인 토큰, 컴포넌트 스킨, 셸 레이아웃으로
  만드는 테마.
- [프로바이더](developers/providers/) — 통합 어댑터 계약을 구현하는 프로바이더
  어댑터.
- [레거시 호환성](developers/legacy-compat) — SillyTavern 시대 플러그인과
  스크립트를 위한 호환 계층.

[API 레퍼런스](api/)는 모든 사이트 빌드에서 TypeDoc이 SDK 소스로부터
생성하므로, 멤버 페이지는 항상 게시된 패키지와 일치합니다.

## 데스크톱

[데스크톱](developers/desktop/) 섹션은 Tauri 2 셸, Node.js 사이드카, 설치 프로그램과
포터블 빌드의 패키징 방식을 문서화합니다.
