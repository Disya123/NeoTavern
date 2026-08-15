/**
 * Avatar asset data-plane hook (M5 slice 6, ТЗ §34 avatar→asset).
 *
 * Resolves a canonical `avatarAssetId` (kernel plane) to a `data:` URI over
 * the NeoBackend facade. Components never branch on the backend kind (ТЗ
 * §13.1): the hook stays disabled while `assetId` is `null`/`undefined`, and
 * the legacy plane never produces an asset id (its avatars are plain URLs),
 * so `readAssetContentDataUrl` is only invoked for kernel data.
 */
import { useQuery } from '@tanstack/react-query';
import { readAssetContentDataUrl } from './wireBridge.js';

/** Stable key shared by avatar consumers and precise invalidations. */
export const avatarQueryKeys = {
  dataUrl: (assetId: string) => ['asset-data-url', assetId] as const,
};

export function useAvatarDataUrl(
  assetId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: avatarQueryKeys.dataUrl(assetId ?? ''),
    queryFn: () => readAssetContentDataUrl(assetId as string),
    enabled: enabled && assetId != null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
