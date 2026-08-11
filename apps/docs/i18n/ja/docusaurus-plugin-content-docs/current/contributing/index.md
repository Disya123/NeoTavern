---
title: NeoTavern へのコントリビューション
description: NeoTavern へのコントリビューション方法 — 問題報告、コード、ドキュメント、翻訳
sidebar_position: 1
---

NeoTavern はオープンなプロジェクトで、あらゆる種類のコントリビューションを歓迎します: バグ報告、機能リクエスト、コード、ドキュメント、翻訳です。

## コントリビューションの方法

- **バグを報告し、機能をリクエストする。** バージョン、OS、再現手順を添えて GitHub に issue を開いてください: [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **コードを書く。** issue を選び、コメントし、プルリクエストを開いてください。変更は小さく保ち、[コードガイドライン](contributing/code-guidelines) に従ってください。
- **ドキュメントを改善する。** 公開サイトは `apps/docs` にあります。[ドキュメントサイト](contributing/docs-site) を参照してください。
- **翻訳する。** 8 つのロケールのいずれかを手伝うか、新しいロケールを提案してください。[翻訳](contributing/translations) を参照してください。

## 行動規範

他のコントリビューターを尊重してください。レビューと issue では建設的に、善意を前提にし、議論は作業に集中させてください。リポジトリの [AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md) は、プロジェクトがどう構築され、タスクがどう完了するかの権威ある説明です。最初の変更の前に読んでください。

## 始める前に

- まず[開発環境のセットアップ](contributing/development-setup) と[コードガイドライン](contributing/code-guidelines)、上記の AGENTS.md ファイルを読んでください。
- やりたいことをカバーする既存の issue を探し、大規模な作業を始める前にコメントしてメンテナーが早期フィードバックを出せるようにしてください。
- プルリクエストは焦点を絞ってください: PR ごとに 1 つの論理的な変更、テストとドキュメントを含めてください。

## 提出後に起こること

メンテナーが変更をレビューし、CI が品質ゲート — lint、型チェック、テスト — を実行します。すべてがグリーンになるとプルリクエストはマージされ、ユーザーに見える変更は変更履歴に載ります。
