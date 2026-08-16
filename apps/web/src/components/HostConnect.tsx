/**
 * Host-connect gate (M6). Shown on the Android packaged UI (and on a
 * browser `?connect=` remote-flow) BEFORE AuthGate.
 *
 * Skin lives in `@neotavern/ui` (`[data-component='host-connect']` + Card /
 * Button / TextField / Segmented). Themes restyle it through `--st-*` tokens
 * and the `theme` cascade layer — there is no CSS Module palette.
 *
 * `ThemeSync` mounts above this gate so an already-installed kernel theme
 * (Android local kernel, or a remote host after reconnect) paints the first
 * frame. Without a reachable theme list the built-in Theme SDK defaults apply.
 */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PlugsConnected } from '@phosphor-icons/react';
import { Button, Card, Segmented, TextField } from '@neotavern/ui';
import { ProductError, TransportError } from '@neotavern/client-sdk';
import { setActiveBackend } from '../api/backend.js';
import {
  HOST_CONNECT_EVENT,
  needsHostConnect,
  readConnectQuery,
  readHostSession,
  writeHostSession,
  writeRemoteToken,
} from '../api/hostSession.js';
import { parsePairingLink } from '../api/pairingLink.js';
import { resolveBackend } from '../api/profiles.js';
import { createRemoteBackend } from '../api/remoteWire.js';
import { isMobileShell } from '../lib/mobile.js';

type ConnectMode = 'local' | 'link' | 'qr';
type ConnectError = 'invalid' | 'failed' | 'token' | 'qr-unavailable' | null;

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
}

function getBarcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (
    window as unknown as {
      BarcodeDetector?: new (options?: { formats: string[] }) => BarcodeDetectorLike;
    }
  ).BarcodeDetector;
  if (ctor === undefined) return null;
  return new ctor({ formats: ['qr_code'] });
}

function canScanQr(): boolean {
  const ctor = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof ctor === 'function' && navigator.mediaDevices?.getUserMedia !== undefined;
}

function errorDetail(caught: unknown): string {
  if (caught instanceof TransportError) {
    const cause = caught.cause instanceof Error ? caught.cause.message : undefined;
    return cause === undefined ? caught.message : `${caught.message}: ${cause}`;
  }
  if (caught instanceof Error) return caught.message;
  return String(caught);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ProductError && error.code === 'UNAUTHORIZED';
}

async function connectRemote(raw: string, extraToken?: string): Promise<void> {
  const parsed = parsePairingLink(raw);
  if (parsed === null) {
    throw new Error('invalid');
  }
  const token = extraToken?.trim() || parsed.token;
  const remote = createRemoteBackend(parsed.baseUrl, token);
  await remote.meta();
  try {
    await remote.characters.list({});
  } catch (error) {
    if (isUnauthorized(error)) {
      throw new Error('token');
    }
  }
  setActiveBackend(remote);
  writeHostSession({ kind: 'remote', url: parsed.baseUrl });
  writeRemoteToken(token);
}

function connectLocal(): void {
  const { backend } = resolveBackend({ id: 'local', kind: 'local', label: 'Local' });
  setActiveBackend(backend);
  writeHostSession({ kind: 'local' });
  writeRemoteToken(undefined);
}

function stopMedia(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function defaultConnectMode(mobile: boolean): ConnectMode {
  const session = readHostSession();
  if (session?.kind === 'local') return 'link';
  if (session?.kind === 'remote' && mobile) return 'local';
  return mobile ? 'local' : 'link';
}

function defaultConnectAddress(): string {
  const preset = readConnectQuery();
  if (preset !== null) return preset;
  const session = readHostSession();
  return session?.kind === 'remote' ? session.url : '';
}

export function HostConnect({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mobile = isMobileShell();
  const [open, setOpen] = useState(() => needsHostConnect());
  const [mode, setMode] = useState<ConnectMode>(() => defaultConnectMode(mobile));
  const [address, setAddress] = useState(() => defaultConnectAddress());
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConnectError>(null);
  const [debugDetail, setDebugDetail] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const autoConnectTried = useRef(false);
  const scanner = canScanQr();

  useEffect(() => {
    const preset = readConnectQuery();
    if (!open || preset === null || autoConnectTried.current) return;
    autoConnectTried.current = true;
    setAddress(preset);
    setMode('link');
    setBusy(true);
    void connectRemote(preset)
      .then(() => {
        queryClient.clear();
        setOpen(false);
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : 'failed';
        setDebugDetail(errorDetail(caught));
        setError(message === 'token' ? 'token' : message === 'invalid' ? 'invalid' : 'failed');
      })
      .finally(() => setBusy(false));
  }, [open, queryClient]);

  useEffect(() => {
    return () => stopMedia(mediaRef.current);
  }, []);

  useEffect(() => {
    const reopen = (): void => {
      setError(null);
      setDebugDetail(null);
      setMode(defaultConnectMode(mobile));
      setAddress(defaultConnectAddress());
      setOpen(true);
    };
    window.addEventListener(HOST_CONNECT_EVENT, reopen);
    return () => window.removeEventListener(HOST_CONNECT_EVENT, reopen);
  }, [mobile]);

  if (!open) return children;

  const canDismiss = readHostSession() !== null;

  const dismiss = (): void => {
    stopMedia(mediaRef.current);
    mediaRef.current = null;
    setScanning(false);
    setError(null);
    setDebugDetail(null);
    setOpen(false);
  };

  const cancelButton = canDismiss ? (
    <Button
      variant="default"
      type="button"
      data-action="cancel-host-connect"
      disabled={busy || scanning}
      onClick={dismiss}
    >
      {t('common:cancel')}
    </Button>
  ) : null;

  const errorText =
    error === 'invalid'
      ? t('auth:connectInvalidUrl')
      : error === 'failed'
        ? t('auth:connectFailed')
        : error === 'token'
          ? t('auth:connectTokenRequired')
          : error === 'qr-unavailable'
            ? t('auth:connectQrUnavailable')
            : null;

  const options: Array<{ value: ConnectMode; label: string }> = [
    ...(mobile ? [{ value: 'local' as const, label: t('auth:connectLocal') }] : []),
    { value: 'link', label: t('auth:connectLink') },
    { value: 'qr', label: t('auth:connectQr') },
  ];

  const finishRemote = (raw: string): void => {
    if (busy) return;
    setError(null);
    setDebugDetail(null);
    setBusy(true);
    void connectRemote(raw, token)
      .then(() => {
        queryClient.clear();
        setOpen(false);
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : 'failed';
        setDebugDetail(errorDetail(caught));
        setError(message === 'invalid' || message === 'token' ? message : 'failed');
      })
      .finally(() => setBusy(false));
  };

  const submitLink = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    finishRemote(address);
  };

  const submitLocal = (): void => {
    if (busy) return;
    setError(null);
    try {
      connectLocal();
      queryClient.clear();
      setOpen(false);
    } catch {
      setError('failed');
    }
  };

  const submitQrScan = (): void => {
    if (busy || scanning) return;
    const detector = getBarcodeDetector();
    if (detector === null || navigator.mediaDevices?.getUserMedia === undefined) {
      setError('qr-unavailable');
      return;
    }
    setError(null);
    setScanning(true);
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        mediaRef.current = stream;
        const video = videoRef.current;
        if (video === null) {
          stopMedia(stream);
          setError('qr-unavailable');
          return;
        }
        video.srcObject = stream;
        await video.play();
        const raw = await scanUntilValue(detector, video);
        stopMedia(stream);
        mediaRef.current = null;
        setScanning(false);
        setAddress(raw);
        setBusy(true);
        await connectRemote(raw, token);
        queryClient.clear();
        setOpen(false);
      } catch (caught: unknown) {
        stopMedia(mediaRef.current);
        mediaRef.current = null;
        setScanning(false);
        const message = caught instanceof Error ? caught.message : 'failed';
        if (message === 'invalid' || message === 'token') {
          setError(message);
          return;
        }
        setError('qr-unavailable');
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <main
      data-component="host-connect"
      data-connect-error={error ?? undefined}
      data-connect-detail={debugDetail ?? undefined}
    >
      <Card data-part="panel">
        <header data-part="header">
          <span data-part="mark">
            <PlugsConnected weight="duotone" aria-hidden="true" />
          </span>
          <p data-part="eyebrow">{t('auth:connectEyebrow')}</p>
          <h1 data-part="title">{t('common:appName')}</h1>
          <p data-part="subtitle">{t('auth:connectSubtitle')}</p>
        </header>
        <div data-part="body">
          <Segmented
            value={mode}
            options={options}
            ariaLabel={t('auth:connectModes')}
            onChange={(next) => {
              setMode(next);
              setError(null);
            }}
          />
          {mode === 'local' ? (
            <>
              <p data-part="hint">{t('auth:connectLocalHint')}</p>
              {errorText ? (
                <p data-part="error" role="alert">
                  {errorText}
                </p>
              ) : null}
              <div data-part="actions">
                <Button
                  variant="primary"
                  data-action="use-on-this-device"
                  disabled={busy}
                  onClick={submitLocal}
                >
                  {t('auth:connectLocalAction')}
                </Button>
                {cancelButton}
              </div>
            </>
          ) : null}
          {mode === 'link' ? (
            <form data-part="link-form" onSubmit={submitLink}>
              <TextField
                label={t('auth:connectServerAddress')}
                description={t('auth:connectLinkHint')}
                value={address}
                autoComplete="url"
                inputMode="url"
                disabled={busy}
                error={error === 'invalid' || error === 'failed' ? errorText : undefined}
                onChange={(event) => {
                  setAddress(event.target.value);
                  if (error) setError(null);
                }}
              />
              <TextField
                label={t('auth:connectToken')}
                description={t('auth:connectTokenHint')}
                value={token}
                type="password"
                autoComplete="off"
                disabled={busy}
                error={error === 'token' ? errorText : undefined}
                onChange={(event) => {
                  setToken(event.target.value);
                  if (error) setError(null);
                }}
              />
              <div data-part="actions">
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || address.trim().length === 0}
                >
                  {busy ? t('auth:connectConnecting') : t('auth:connectAction')}
                </Button>
                {cancelButton}
              </div>
            </form>
          ) : null}
          {mode === 'qr' ? (
            <form data-part="link-form" onSubmit={submitLink}>
              <p data-part="hint">{t('auth:connectQrHint')}</p>
              <video
                ref={videoRef}
                data-part="preview"
                data-state={scanning ? 'scanning' : 'idle'}
                muted
                playsInline
                autoPlay
              />
              <TextField
                label={t('auth:connectQrPaste')}
                description={t('auth:connectQrPasteHint')}
                value={address}
                autoComplete="url"
                inputMode="url"
                disabled={busy || scanning}
                error={errorText}
                onChange={(event) => {
                  setAddress(event.target.value);
                  if (error) setError(null);
                }}
              />
              <TextField
                label={t('auth:connectToken')}
                description={t('auth:connectTokenHint')}
                value={token}
                type="password"
                autoComplete="off"
                disabled={busy || scanning}
                onChange={(event) => {
                  setToken(event.target.value);
                  if (error) setError(null);
                }}
              />
              <div data-part="actions">
                {scanner ? (
                  <Button
                    variant="default"
                    data-action="scan-qr"
                    disabled={busy || scanning}
                    onClick={submitQrScan}
                  >
                    {scanning ? t('auth:connectConnecting') : t('auth:connectQrAction')}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || scanning || address.trim().length === 0}
                >
                  {busy ? t('auth:connectConnecting') : t('auth:connectAction')}
                </Button>
                {cancelButton}
              </div>
            </form>
          ) : null}
        </div>
      </Card>
    </main>
  );
}

async function scanUntilValue(
  detector: BarcodeDetectorLike,
  video: HTMLVideoElement,
): Promise<string> {
  for (;;) {
    const codes = await detector.detect(video);
    const value = codes[0]?.rawValue;
    if (typeof value === 'string' && value.length > 0) return value;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}
