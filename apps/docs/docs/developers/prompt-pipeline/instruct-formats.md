---
title: Instruct Formats
description: >-
  How instruct formats render the clean message array with sandboxed
  Handlebars templates, the built-in formats, and versioned JSON presets.
sidebar_position: 3
---

Instruct formats define how the clean message array is rendered into a
prompt string, using sandboxed Handlebars templates that have no access to
the filesystem or to code execution.

## The Format Manager

A built-in format manager owns instruct formats. Formats are Handlebars
templates rendered in an isolated environment: templates receive only
`content`, `role`, and `name`, and only documented helpers are available.
Templates get no Node.js access, no filesystem access, and no way to
execute arbitrary code.

A format describes:

- system, user, assistant, and tool templates;
- BOS and EOS tokens;
- message separators;
- special tokens.

## Built-in Formats

NeoTavern ships with these formats:

- **ChatML** — `<|im_start|>` / `<|im_end|>` role blocks.
- **Llama 3** — `<|begin_of_text|>` with role tags.
- **Alpaca** — instruction and response blocks.
- **Mistral** — `[INST]` / `[/INST]` blocks.
- **Command-R** — `<|START_OF_TURN_TOKEN|>` blocks.
- **Custom formats** — user-defined templates, selectable as the active
  format.

## Clean Message Array Until Render

Until the render stage, the pipeline works exclusively with a structured
array of messages with roles (`system`, `user`, `assistant`, `tool`). Macros
are resolved, lorebook and memory are inserted, context shifting removes
excess, and plugin interceptors modify this array. Rendering happens exactly
once, at the render stage, so no adapter re-formats the prompt a second
time.

## Final Output

The render stage produces one of two shapes:

- **A string** — the rendered prompt, sent to text-completion providers and
  used for diagnostics.
- **Structured JSON** — the `GenerationMessage[]` array, sent to chat
  providers that accept role-tagged messages.

The mode is selected by `serializeAsText`: text adapters (`text-completion`,
`novelai`, `ai-horde`, `koboldai`) always receive the rendered instruct
prompt as a single `user` message; chat adapters (`openai-compatible`,
`anthropic`) receive the structured array.

## Macros

`{{user}}`, `{{char}}`, and custom variables are resolved before the final
render. Macros are never expanded inside the template engine itself, so
template files stay pure markup.

## Custom Formats and Presets

The active custom format is stored in `AppSettings.instructFormat`. When
set, the clean message array is rendered into a single string and the
format's stop strings become the request's stop sequences. When `null`, the
native structured serialization is used.

Formats are imported and exported as **versioned JSON presets**:

- `importInstructFormat()` validates the preset before it becomes active;
- `exportInstructFormat()` produces JSON-safe, separated values;
- presets carry a version, so older exports can be migrated on import.

## See Also

- [Pipeline Stages](stages) for where rendering sits in the stage order.
- [Tokenization](tokenization) for how the rendered context is counted.
- [Providers](../providers/) for how adapters consume the serialized
  output.
