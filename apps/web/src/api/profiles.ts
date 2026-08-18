/**
 * Backend profiles (ТЗ §7.2 / §16).
 *
 * A profile selects which backend the UI talks to. Local profiles run the
 * in-process kernel (mobile WebView bridge / Tauri IPC). Remote profiles
 * talk Product Wire HTTP (`RemoteBackend` + `HttpTransport`) to Headless
 * or Desktop Remote Access — selectable from the themed HostConnect gate
 * (M6; ADR-0034 originally deferred this to Phase 9).
 *
 * Profile state is local UI state only — host-managed caches and credentials
 * never touch this store. Pairing tokens live in sessionStorage / memory,
 * not here.
 */
import { create } from 'zustand';
import {
  LocalBackend,
  UnsupportedError,
  type LocalTransport,
  type NeoBackend,
} from '@neotavern/neobackend';
import { isMobileShell } from '../lib/mobile.js';
import { readRemoteToken } from './hostSession.js';
import { MobileBridgeTransport } from './mobileTransport.js';
import { createRemoteBackend } from './remoteWire.js';
import { isTauriRuntime, TauriTransport } from './tauriTransport.js';

export type Profile = {
  id: string;
  kind: 'local' | 'remote';
  label: string;
  remoteUrl?: string;
};

export interface ProfileStore {
  profiles: Profile[];
  activeProfileId: string;
  setActiveProfile: (id: string) => void;
  registerProfile: (p: Profile) => void;
}

export const useProfileStore = create<ProfileStore>((set) => ({
  profiles: [],
  activeProfileId: '',
  setActiveProfile: (id) => set({ activeProfileId: id }),
  registerProfile: (profile) =>
    set((state) => {
      const exists = state.profiles.some((p) => p.id === profile.id);
      return {
        profiles: exists
          ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
          : [...state.profiles, profile],
      };
    }),
}));

/**
 * Resolve a profile to its backend. Local profiles run `LocalBackend` over
 * the shell transport; remote profiles require `remoteUrl` and build
 * `RemoteBackend` over the product-wire HTTP transport.
 */
export function resolveBackend(profile: Profile): { backend: NeoBackend } {
  if (profile.kind === 'local') {
    let transport: LocalTransport;
    if (isMobileShell()) {
      transport = new MobileBridgeTransport();
    } else if (isTauriRuntime()) {
      transport = new TauriTransport();
    } else {
      // A local kernel profile cannot run in a plain browser: there is no
      // in-process kernel to talk to (no HTTP fallback for local profiles).
      throw new UnsupportedError('profile.local.shell');
    }
    return { backend: new LocalBackend({ transport }) };
  }
  const remoteUrl = profile.remoteUrl?.trim();
  if (remoteUrl === undefined || remoteUrl.length === 0) {
    throw new UnsupportedError('profile.remote.url');
  }
  return { backend: createRemoteBackend(remoteUrl, readRemoteToken()) };
}
