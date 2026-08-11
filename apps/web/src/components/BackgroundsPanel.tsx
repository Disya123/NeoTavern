/**
 * Chat background (wallpaper) management: upload, list, delete and applying a
 * background to the currently open chat. The catalog lives on the server in
 * `data/files/backgrounds/` (filesystem-authoritative, ST1-imported originals
 * show up here too).
 */
import { ImageSquare, UploadSimple, Trash, Check } from '@phosphor-icons/react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import type { BackgroundItem } from '@neotavern/contracts';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
  useRowGestures,
} from '@neotavern/ui';
import {
  useBackgrounds,
  useChat,
  useDeleteBackground,
  useUpdateChat,
  useUploadBackground,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { useUiStore } from '../state/ui.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import styles from './BackgroundsPanel.module.css';

interface BackgroundsPanelProps {
  onClose: () => void;
}

function readChatId(pathname: string): string | null {
  const match = /^\/chats\/([^/]+)$/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function BackgroundsPanel({ onClose }: BackgroundsPanelProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const errorText = useErrorText();
  const inputId = useId();
  const [deleteTarget, setDeleteTarget] = useState<BackgroundItem | null>(null);
  const [menuTarget, setMenuTarget] = useState<BackgroundItem | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const chatId = useMemo(() => readChatId(location.pathname), [location.pathname]);
  const chat = useChat(chatId ?? undefined);

  const globalBackgroundId = useUiStore((state) => state.globalBackgroundId);
  const setGlobalBackgroundId = useUiStore((state) => state.setGlobalBackgroundId);

  const backgrounds = useBackgrounds();
  const upload = useUploadBackground();
  const remove = useDeleteBackground();
  const updateChat = useUpdateChat();

  const items = backgrounds.data?.items ?? [];
  const appliedId = chat.data?.backgroundId ?? globalBackgroundId ?? null;
  const busy = upload.isPending || remove.isPending || updateChat.isPending;

  const handleApply = async (background: BackgroundItem): Promise<void> => {
    setPanelError(null);
    setGlobalBackgroundId(background.id);
    if (chatId) {
      try {
        await updateChat.mutateAsync({ id: chatId, update: { backgroundId: background.id } });
      } catch (error) {
        setPanelError(errorText(error));
      }
    }
  };

  const handleClear = async (): Promise<void> => {
    setPanelError(null);
    setGlobalBackgroundId(null);
    if (chatId) {
      try {
        await updateChat.mutateAsync({ id: chatId, update: { backgroundId: null } });
      } catch (error) {
        setPanelError(errorText(error));
      }
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setPanelError(null);
    try {
      if (appliedId === deleteTarget.id) {
        void handleClear();
      }
      await remove.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    setPanelError(null);
    upload.mutate(file, {
      onError: (error) => setPanelError(errorText(error)),
    });
  };

  const handleCardClick = (background: BackgroundItem) => {
    // A drag finished or a long-press menu just opened on this card: the
    // follow-up click only closes the menu, it must not apply/clear.
    if (consumeClick() || menuTarget) {
      setMenuTarget(null);
      return;
    }
    if (appliedId === background.id) {
      void handleClear();
    } else {
      void handleApply(background);
    }
  };

  // Shared row gestures (@neotavern/gestures): right-click opens the card menu,
  // a stationary touch hold does the same after 700 ms; cards are never
  // draggable, so long-press suppression only guards the menu click.
  const { consumeClick, handlers } = useRowGestures({
    indexAttribute: 'data-background-index',
    canDrag: () => false,
    onOpenMenu: (backgroundId) => {
      const background = items.find((item) => item.id === backgroundId);
      if (!background) return;
      setMenuTarget(background);
    },
  });

  const mutationError = upload.error ?? remove.error ?? updateChat.error ?? null;
  const panelErrorMessage = panelError ?? (mutationError ? errorText(mutationError) : null);

  return (
    <FloatingTabPanel
      component="backgrounds-panel"
      headerPart="backgrounds-header"
      avatar={
        <span className={styles.headerAvatar} aria-hidden="true">
          <ImageSquare size={20} />
        </span>
      }
      title={t('backgrounds:managementTitle')}
      onClose={onClose}
    >
      <ScrollArea className={styles.body}>
        <div className={styles.content}>
          <div className={styles.uploadRow}>
            <Button variant="primary" startIcon={<UploadSimple />} disabled={busy} asChild>
              <label htmlFor={inputId}>
                {upload.isPending ? t('backgrounds:uploading') : t('backgrounds:upload')}
              </label>
            </Button>
            <input
              id={inputId}
              className={styles.fileInput}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
              disabled={busy}
              onChange={(event) => onFile(event.target.files?.[0])}
            />
            <p className={styles.uploadHint}>{t('backgrounds:uploadHint')}</p>
          </div>

          {panelErrorMessage ? (
            <p className={styles.error} role="alert">
              {panelErrorMessage}
            </p>
          ) : null}

          {backgrounds.isLoading ? (
            <div className={styles.state} aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className={styles.skeleton} />
              ))}
            </div>
          ) : backgrounds.isError ? (
            <div className={styles.state}>
              <p className={styles.error} role="alert">
                {errorText(backgrounds.error)}
              </p>
              <Button variant="ghost" onClick={() => void backgrounds.refetch()}>
                {t('common:retry')}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className={styles.state}>
              <span className={styles.stateIcon} aria-hidden="true">
                <ImageSquare size={28} weight="duotone" />
              </span>
              <h3>{t('backgrounds:emptyTitle')}</h3>
              <p>{t('backgrounds:emptyHint')}</p>
            </div>
          ) : (
            <ul className={styles.grid}>
              {items.map((background, index) => {
                const applied = appliedId === background.id;
                return (
                  <DropdownMenu
                    key={background.id}
                    open={menuTarget?.id === background.id}
                    onOpenChange={(open) => {
                      if (!open) setMenuTarget(null);
                    }}
                  >
                    <DropdownMenuTrigger asChild disabled>
                      <li
                        className={styles.card}
                        title={background.name}
                        data-applied={applied ? 'true' : 'false'}
                        data-background-index={index}
                        onClick={() => handleCardClick(background)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleCardClick(background);
                          }
                        }}
                        {...handlers(background.id, index)}
                      >
                        <div className={styles.preview}>
                          {background.thumbnailUrl ? (
                            <img
                              src={background.thumbnailUrl}
                              alt={background.name}
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <span className={styles.previewFallback} aria-hidden="true">
                              <ImageSquare size={22} />
                            </span>
                          )}
                          {applied ? (
                            <Badge
                              tone="accent"
                              icon={<Check size={14} weight="bold" aria-hidden="true" />}
                            >
                              {t('backgrounds:applied')}
                            </Badge>
                          ) : null}
                        </div>
                      </li>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onSelect={() => {
                          const target = menuTarget;
                          if (!target) return;
                          if (appliedId === target.id) {
                            void handleClear();
                          } else {
                            void handleApply(target);
                          }
                        }}
                      >
                        <Check aria-hidden="true" />
                        {menuTarget && appliedId === menuTarget.id
                          ? t('backgrounds:clear')
                          : t('backgrounds:apply')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDeleteTarget(menuTarget)}>
                        <Trash aria-hidden="true" />
                        {t('backgrounds:delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>

      <ConfirmActionDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('backgrounds:deleteTitle')}
        description={t('backgrounds:deleteConfirm', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('common:delete')}
        danger
        busy={remove.isPending}
        onConfirm={() => void handleDelete()}
      />
    </FloatingTabPanel>
  );
}
