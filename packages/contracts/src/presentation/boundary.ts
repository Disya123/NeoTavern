/**
 * Presentation boundary. Milestone A is STARTED; this module is the Product
 * Wire boundary (PASS). It is not Milestone A PASS: a Dioxus product shell,
 * React ↔ Dioxus view-model parity, and presentation-path streaming tests
 * are still required. Presentation consumes Product Wire; it does not own
 * durable product state. D3 is DEFERRED: Android may take a flagged Rust
 * path, Web stays React, production Android stays WebView.
 */
import { Type, type Static } from '@sinclair/typebox';
import { buildProductWireRegistry } from '../wire/registry.js';

export const PresentationSurfaceSchema = Type.Union([
  Type.Literal('react-web'),
  Type.Literal('webview-android-rollback'),
  Type.Literal('dioxus-android-flagged'),
]);
export type PresentationSurface = Static<typeof PresentationSurfaceSchema>;

export const PRODUCTION_ANDROID_SURFACE: PresentationSurface = 'webview-android-rollback';

export const PresentationCommandSchema = Type.Object({
  wireOperationId: Type.String({ minLength: 1 }),
});
export type PresentationCommand = Static<typeof PresentationCommandSchema>;

export const PresentationFixtureSchema = Type.Object({
  surface: PresentationSurfaceSchema,
  wireOperationIds: Type.Array(Type.String({ minLength: 1 })),
  note: Type.String(),
});
export type PresentationFixture = Static<typeof PresentationFixtureSchema>;

export function productWireOperationIds(): ReadonlySet<string> {
  return new Set(buildProductWireRegistry().operations.map((row) => row.operationId));
}

export function assertPresentationConsumesWire(command: PresentationCommand): void {
  const ids = productWireOperationIds();
  if (!ids.has(command.wireOperationId)) {
    throw new Error(
      `presentation command is not a Product Wire operation: ${command.wireOperationId}`,
    );
  }
}

export function recordPresentationFixture(
  surface: PresentationSurface,
  commands: readonly PresentationCommand[],
  note: string,
): PresentationFixture {
  for (const command of commands) {
    assertPresentationConsumesWire(command);
  }
  return {
    surface,
    wireOperationIds: commands.map((command) => command.wireOperationId),
    note,
  };
}
