---
title: 아키텍처
description: >-
  아키텍처 섹션 개요: 모노레포 구조, 승인된 기술 스택, 각 패키지의
  역할을 다룹니다.
sidebar_position: 1
---

이 섹션은 NeoTavern 모노레포가 어떻게 구성되는지, 어떤 기술을
사용하는지, 서버와 웹 클라이언트, 데스크톱 셸이 어떻게 맞물리는지
설명합니다.

## 이 섹션의 페이지

- [모노레포 개요](architecture/overview) — `apps/`와 `packages/`의 구조, 서버와 웹
  사이의 데이터 흐름, 로컬 퍼스트 원칙.
- [기술 스택](architecture/stack) — 승인된 스택: Node.js 24, Fastify 5, React 19,
  Vite 8, SQLite, Drizzle, Tauri 2, pnpm 워크스페이스.
- [패키지](architecture/packages) — 각 워크스페이스 패키지의 역할과 패키지 사이의
  의존성 방향.

## 관련 섹션

[프롬프트 파이프라인](prompt-pipeline/) 섹션은 생성 단계를 자세히
설명하고, [데이터 및 저장소](data/)는 데이터베이스, 파일 처리,
백업을 문서화합니다.
