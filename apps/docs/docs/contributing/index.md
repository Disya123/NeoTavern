---
title: Contributing to NeoTavern
description: How to contribute to NeoTavern — issues, code, documentation, and translations
sidebar_position: 1
---

NeoTavern is an open project, and contributions of every kind are welcome: bug
reports, feature requests, code, documentation, and translations.

## Ways to Contribute

- **Report bugs and request features.** Open an issue on GitHub with the
  version, your OS, and steps to reproduce:
  [https://github.com/Disya123/NeoTavern/issues](https://github.com/Disya123/NeoTavern/issues)
- **Write code.** Pick an issue, comment on it, and open a pull request. Keep
  changes small and follow the [Code Guidelines](contributing/code-guidelines).
- **Improve the documentation.** The public site lives in `apps/docs`; see
  [Documentation Site](contributing/docs-site).
- **Translate.** Help with one of the eight locales or propose a new one; see
  [Translations](contributing/translations).

## Code of Conduct

Treat other contributors with respect. Be constructive in reviews and issues,
assume good faith, and keep discussion focused on the work. The repository's
[AGENTS.md](https://github.com/Disya123/NeoTavern/blob/main/AGENTS.md) is the
authoritative description of how the project is built and how tasks are
completed; read it before your first change.

## Before You Start

- Read the [Development Setup](contributing/development-setup) and the
  [Code Guidelines](contributing/code-guidelines) first, plus the AGENTS.md file linked
  above.
- Look for an existing issue covering what you want to do, and comment before
  starting large work so maintainers can give early feedback.
- Keep pull requests focused: one logical change per PR, with tests and
  documentation included.

## What Happens After You Submit

Maintainers review the change and CI runs the quality gates — lint, typecheck,
and tests. Once everything is green, the pull request is merged and
user-visible changes land in the changelog.
