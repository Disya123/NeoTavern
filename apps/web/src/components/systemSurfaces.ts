import type { Location } from 'react-router-dom';

/** System-owned management surfaces that must open over the chat workspace. */
export type SystemSurfaceId =
  'characters' | 'chats' | 'providers' | 'themes' | 'plugins' | 'plugin';

export interface SystemSurfaceDefinition {
  id: Exclude<SystemSurfaceId, 'plugin'>;
  path: string;
  labelKey: string;
  descriptionKey: string;
}

/**
 * Single source of truth for built-in management surfaces. Shells may change
 * presentation, but these destinations always remain overlays above chat.
 */
export const SYSTEM_SURFACES = [
  {
    id: 'characters',
    path: '/characters',
    labelKey: 'navigation:characters',
    descriptionKey: 'characters:subtitle',
  },
  {
    id: 'chats',
    path: '/chats',
    labelKey: 'navigation:chats',
    descriptionKey: 'chat:librarySubtitle',
  },
  {
    id: 'providers',
    path: '/providers',
    labelKey: 'navigation:providers',
    descriptionKey: 'providers:subtitle',
  },
  {
    id: 'plugins',
    path: '/plugins',
    labelKey: 'navigation:plugins',
    descriptionKey: 'plugins:subtitle',
  },
  {
    id: 'themes',
    path: '/themes',
    labelKey: 'navigation:themes',
    descriptionKey: 'themes:subtitle',
  },
] as const satisfies readonly SystemSurfaceDefinition[];

export interface SystemSurfaceMatch {
  id: SystemSurfaceId;
  definition: SystemSurfaceDefinition;
  pluginId?: string;
  pluginPath?: string;
}

export function matchSystemSurface(pathname: string): SystemSurfaceMatch | undefined {
  if (pathname.startsWith('/plugins/')) {
    const definition = SYSTEM_SURFACES.find((surface) => surface.id === 'plugins');
    const [encodedPluginId, ...pathParts] = pathname.slice('/plugins/'.length).split('/');
    if (definition && encodedPluginId) {
      let pluginId = encodedPluginId;
      try {
        pluginId = decodeURIComponent(encodedPluginId);
      } catch {
        return undefined;
      }
      return {
        id: 'plugin',
        definition,
        pluginId,
        pluginPath: `/${pathParts.join('/')}`,
      };
    }
  }

  const definition = SYSTEM_SURFACES.find((surface) => surface.path === pathname);
  return definition ? { id: definition.id, definition } : undefined;
}

function isLocation(value: unknown): value is Location {
  return (
    value !== null &&
    typeof value === 'object' &&
    'pathname' in value &&
    typeof value.pathname === 'string' &&
    'search' in value &&
    typeof value.search === 'string' &&
    'hash' in value &&
    typeof value.hash === 'string' &&
    'key' in value &&
    typeof value.key === 'string'
  );
}

export interface SurfaceNavigationState {
  backgroundLocation: Location;
}

/** Returns the persistent chat location carried by modal route history. */
export function getBackgroundLocation(location: Location): Location | undefined {
  const state: unknown = location.state;
  if (state === null || typeof state !== 'object' || !('backgroundLocation' in state)) {
    return undefined;
  }
  return isLocation(state.backgroundLocation) ? state.backgroundLocation : undefined;
}

/** Keeps the current chat mounted while another system surface opens. */
export function createSurfaceNavigationState(location: Location): SurfaceNavigationState {
  const existingBackground = getBackgroundLocation(location);
  if (existingBackground) return { backgroundLocation: existingBackground };
  if (!matchSystemSurface(location.pathname)) return { backgroundLocation: location };
  return {
    backgroundLocation: {
      pathname: '/home',
      search: '',
      hash: '',
      state: null,
      key: 'system-surface-home',
    },
  };
}
