/**
 * Configuration profiles hooks (ТЗ §8.1 Configuration, Этап 4 slice 5
 * remainder). Server state belongs in TanStack Query (AGENTS.md §13); every
 * operation goes through the NeoBackend facade (ТЗ §13.1) — never the
 * legacy HTTP surface directly.
 *
 * Profile CRUD + the SEC-02 logical profile export (ADR-0047 waiver 4):
 * an optional profileId scopes the export to one profile's characters and
 * their chats/messages; lorebooks and presets are the shared library and
 * always included. Secrets never enter the container.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateProfileRequestDto,
  ProfileExportRequestDto,
  RenameProfileRequestDto,
} from '@neotavern/contracts';
import { backend } from './backend.js';

const PROFILES_KEY = ['profiles'] as const;

export function useProfiles() {
  return useQuery({
    queryKey: PROFILES_KEY,
    queryFn: () => backend.profiles.list(),
    staleTime: 30_000,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateProfileRequestDto) => backend.profiles.create(req),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useRenameProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: RenameProfileRequestDto) => backend.profiles.rename(req),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) => backend.profiles.del(profileId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROFILES_KEY }),
  });
}

export function useProfileExport() {
  return useMutation({
    mutationFn: (req?: ProfileExportRequestDto) => backend.profiles.export(req),
  });
}
