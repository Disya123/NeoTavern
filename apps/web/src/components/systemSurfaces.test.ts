import { describe, expect, it } from 'vitest';
import type { Location } from 'react-router-dom';
import {
  createSurfaceNavigationState,
  getBackgroundLocation,
  matchSystemSurface,
} from './systemSurfaces.js';

const home: Location = {
  pathname: '/home',
  search: '',
  hash: '',
  state: null,
  key: 'home',
};

describe('system surfaces', () => {
  it.each([
    ['/characters', 'characters'],
    ['/chats', 'chats'],
    ['/providers', 'providers'],
    ['/themes', 'themes'],
    ['/plugins', 'plugins'],
    ['/settings', 'settings'],
    ['/plugins/example/tool', 'plugin'],
  ] as const)('matches %s as the %s modal surface', (path, id) => {
    expect(matchSystemSurface(path)?.id).toBe(id);
  });

  it('keeps chat routes outside the system surface layer', () => {
    expect(matchSystemSurface('/home')).toBeUndefined();
    expect(matchSystemSurface('/chats/chat-7')).toBeUndefined();
  });

  // Settings briefly left this list when it lived only as a sidebar drawer. It is a
  // surface again, on purpose: a drawer shares space with the chat, a window does not.
  it('opens settings as a system surface, not a drawer', () => {
    expect(matchSystemSurface('/settings')?.id).toBe('settings');
  });

  it('carries the mounted workspace through nested modal navigation', () => {
    const first = createSurfaceNavigationState(home);
    const modalLocation: Location = {
      pathname: '/themes',
      search: '',
      hash: '',
      state: first,
      key: 'themes',
    };
    expect(getBackgroundLocation(modalLocation)).toEqual(home);
    expect(createSurfaceNavigationState(modalLocation)).toEqual(first);
  });
});
