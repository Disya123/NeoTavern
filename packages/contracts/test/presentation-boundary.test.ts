import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_ANDROID_SURFACE,
  assertPresentationConsumesWire,
  productWireOperationIds,
  recordPresentationFixture,
} from '../src/presentation/boundary.js';

describe('presentation boundary', () => {
  it('maps typed presentation commands only onto Product Wire operations', () => {
    const ids = productWireOperationIds();
    expect(ids.has('chats.get')).toBe(true);
    expect(ids.has('generation.start')).toBe(true);
    expect(() => assertPresentationConsumesWire({ wireOperationId: 'chats.get' })).not.toThrow();
    expect(() =>
      assertPresentationConsumesWire({ wireOperationId: 'presentation.bypassSqlite' }),
    ).toThrow(/Product Wire/);
  });

  it('records a fixture on the WebView rollback surface', () => {
    const fixture = recordPresentationFixture(
      PRODUCTION_ANDROID_SURFACE,
      [{ wireOperationId: 'chats.list' }, { wireOperationId: 'chats.get' }],
      'Milestone A recorder; not a native UI capture',
    );
    expect(fixture.surface).toBe('webview-android-rollback');
    expect(fixture.wireOperationIds).toEqual(['chats.list', 'chats.get']);
  });
});
