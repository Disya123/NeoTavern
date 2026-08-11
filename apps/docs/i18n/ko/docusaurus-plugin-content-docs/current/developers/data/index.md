---
title: 데이터 및 저장소
description: >-
  데이터 계층 개요: SQLite 데이터베이스, 원본과 캐시의 파일 시스템
  구조, 백업 모델.
sidebar_position: 1
---

이 섹션은 NeoTavern이 데이터를 저장하는 방식을 설명합니다. SQLite
데이터베이스, 원본과 캐시의 파일 시스템 구조, 백업 모델입니다.

## 데이터 디렉터리

모든 사용자 데이터는 하나의 로컬 데이터 디렉터리에 있습니다.

```text
data/
  app.db
  files/{avatars,backgrounds,attachments,audio,generated}/
  plugins/  themes/  cache/thumbnails/  backups/  logs/
```

## 이 섹션의 페이지

- [SQLite 저장소](data/sqlite) — 프래그마, STRICT 테이블, FTS5 검색, 안정적인
  UUIDv7 ID, 마이그레이션.
- [파일 및 이미지](data/files-and-images) — 원본과 재생성 가능한 썸네일이
  저장되고 원자적으로 기록되는 방식.
- [백업](data/backups) — 백업 모델, 복원, 백업이 다루는 범위.

## 관련 섹션

- [아키텍처](architecture/) 섹션은 데이터 계층이 모노레포에서 어디에
  있는지 설명합니다.
- 사용자 관점은 [사용자 가이드](../user-guide/data-and-backups)의
  데이터 및 백업을 참조하세요.
