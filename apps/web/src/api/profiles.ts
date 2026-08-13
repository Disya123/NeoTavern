/**
 * Backend profiles (ТЗ §7.2 Phase 5 / §16).
 *
 * A profile selects which backend the UI talks to. Phase 5 ships the local
 * (in-process kernel) profile for the mobile shell; the remote profile is
 * declared but not selectable yet (Phase 9 scope). Profile state is local UI
 * state only — host-managed caches and credentials (ТЗ §16) never touch this
 * store.
 */
import { create } from 'zustand';
import { LocalBackend, UnsupportedError, type LocalTransport, type NeoBackend } from '@neotavern/neobackend';
import { isMobileShell } from '../lib/mobile.js';
import { MobileBridgeTransport } from './mobileTransport.js';
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
 * the shell transport (mobile WebView bridge in the Android shell, Tauri IPC
 * on desktop); remote profiles throw — they are Phase 9 scope, declared but
 * not selectable.
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
  throw new UnsupportedError('profile.remote');
}
