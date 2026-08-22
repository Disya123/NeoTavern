# Presentation ABI code generation

`codegen.mjs` derives the Rust decoder for the portable `UiBlueprint` JSON
document from `packages/contracts/src/presentation/blueprint.ts`. It is a
migration-tooling boundary, not Product Wire generation and not a renderer.

```powershell
node tools/presentation-codegen/codegen.mjs
node tools/presentation-codegen/codegen.mjs --check
```

The output is `crates/presentation-blueprint/src/generated/ui_blueprint_v1.rs`.
The generator rebuilds `@neotavern/contracts` before reading its TypeBox schema,
so TypeScript remains the sole authored cross-language document definition.
