import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  DownloadSimple,
  MagnifyingGlass,
  Plus,
  PushPin,
  UserCirclePlus,
} from '@phosphor-icons/react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  ActionBarGroup,
  Button,
  Dialog,
  DialogContent,
  ErrorBoundary,
  Skeleton,
  Spinner,
  TextArea,
  TextField,
} from '@neotavern/ui';
import {
  useCharacters,
  useContinueCharacterChat,
  useCreateCharacter,
  useCreateChat,
  useImportCharacter,
  useSettings,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { useUiStore } from '../state/ui.js';
import { PluginCharacterTabsButton } from '../components/PluginCharacterTabs.js';
import styles from './CharactersPage.module.css';

export function CharactersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [searchInput, setSearchInput] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const pinnedCharacterId = useUiStore((state) => state.pinnedCharacterId);
  const setPinnedCharacterId = useUiStore((state) => state.setPinnedCharacterId);

  const characters = useCharacters({ q: appliedQ || undefined, sort: 'newest' });
  const continueCharacterChat = useContinueCharacterChat();
  const createChat = useCreateChat();
  const settings = useSettings();
  const importCharacter = useImportCharacter();
  const items = characters.data?.pages.flatMap((page) => page.items) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 108,
    overscan: 6,
  });

  useEffect(() => {
    if (!characters.hasNextPage || characters.isFetchingNextPage) return;
    const lastVisible = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
    if (lastVisible >= items.length - 3) void characters.fetchNextPage();
  }, [
    virtualizer.getVirtualItems(),
    characters.hasNextPage,
    characters.isFetchingNextPage,
    items.length,
    characters,
  ]);

  const openChat = async (characterId: string, characterName: string): Promise<void> => {
    setActionError(null);
    try {
      const result = await continueCharacterChat.mutateAsync({
        characterId,
        title: characterName,
        ...(settings.data?.activePersonaId ? { personaId: settings.data.activePersonaId } : {}),
      });
      navigate(`/chats/${result.chatId}`);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const createNewChat = async (characterId: string, characterName: string): Promise<void> => {
    setActionError(null);
    try {
      const chat = await createChat.mutateAsync({
        characterId,
        title: characterName,
        reuseUnstarted: true,
        ...(settings.data?.activePersonaId ? { personaId: settings.data.activePersonaId } : {}),
      });
      navigate(`/chats/${chat.id}`);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const importCard = async (file: File): Promise<void> => {
    setImportStatus(t('characters:importing'));
    try {
      const result = await importCharacter.mutateAsync(file);
      setImportStatus(
        result.created
          ? t('characters:importSuccess', { name: result.character.name })
          : t('characters:importExisting', { name: result.character.name }),
      );
    } catch (error) {
      setImportStatus(errorText(error));
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <ErrorBoundary name="characters">
      <div className={styles.page} data-component="character-browser" data-slot="character.browser">
        <header className={styles.header}>
          <div className={styles.heading}>
            <span>{t('characters:eyebrow')}</span>
            <h1>{t('characters:title')}</h1>
            <p>{t('characters:subtitle')}</p>
          </div>
          <div className={styles.controls}>
            <div className={styles.search}>
              <MagnifyingGlass size={20} aria-hidden="true" />
              <input
                aria-label={t('characters:searchPlaceholder')}
                placeholder={t('characters:searchPlaceholder')}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setAppliedQ(searchInput);
                }}
              />
            </div>
            <Button className={styles.searchButton} onClick={() => setAppliedQ(searchInput)}>
              {t('common:search')}
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,.png,application/json,image/png"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importCard(file);
              }}
            />
            <Button
              startIcon={<DownloadSimple />}
              onClick={() => importInputRef.current?.click()}
              disabled={importCharacter.isPending}
            >
              {t('characters:import')}
            </Button>
            <Button variant="primary" startIcon={<Plus />} onClick={() => setCreateOpen(true)}>
              {t('characters:create')}
            </Button>
          </div>
          {importStatus ? (
            <p className={styles.status} aria-live="polite">
              {importStatus}
            </p>
          ) : null}
          {actionError ? (
            <p className={styles.error} role="alert">
              {actionError}
            </p>
          ) : null}
        </header>

        {characters.isLoading ? (
          <div className={styles.skeletonList} aria-label={t('common:loading')}>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton className={styles.skeletonRow} key={index} />
            ))}
          </div>
        ) : characters.isError ? (
          <EmptyState
            title={t('characters:errorTitle')}
            description={errorText(characters.error)}
            action={<Button onClick={() => void characters.refetch()}>{t('common:retry')}</Button>}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={appliedQ ? t('characters:noResultsTitle') : t('characters:emptyTitle')}
            description={
              appliedQ ? t('characters:noResultsDescription') : t('characters:emptyDescription')
            }
            action={
              appliedQ ? (
                <Button
                  onClick={() => {
                    setSearchInput('');
                    setAppliedQ('');
                  }}
                >
                  {t('characters:clearSearch')}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden="true" />
                  {t('characters:create')}
                </Button>
              )
            }
          />
        ) : (
          <div ref={scrollRef} className={styles.list} data-component="character-list">
            <div className={styles.virtualCanvas} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const character = items[virtualRow.index];
                if (!character) return null;
                const isPinned = pinnedCharacterId === character.id;
                return (
                  <article
                    key={character.id}
                    data-component="character-card"
                    data-state={isPinned ? 'pinned' : 'default'}
                    className={styles.card}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {character.avatar ? (
                      <img
                        className={styles.avatar}
                        src={character.avatar}
                        alt={t('characters:avatarAlt', { name: character.name })}
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.avatarFallback} aria-hidden="true">
                        {character.name.slice(0, 1).toLocaleUpperCase()}
                      </span>
                    )}
                    <div className={styles.cardBody}>
                      <strong>{character.name}</strong>
                      <p className={styles.desc}>
                        {character.description || t('characters:noDescription')}
                      </p>
                      <div className={styles.tags}>
                        {character.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className={styles.tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className={styles.cardActions}>
                      <PluginCharacterTabsButton
                        characterId={character.id}
                        characterName={character.name}
                      />
                      <Button
                        variant={isPinned ? 'default' : 'ghost'}
                        size="sm"
                        aria-label={
                          isPinned
                            ? t('characters:pinned', { name: character.name })
                            : t('characters:pin', { name: character.name })
                        }
                        onClick={() => setPinnedCharacterId(character.id)}
                      >
                        <PushPin weight={isPinned ? 'fill' : 'regular'} aria-hidden="true" />
                        <span className={styles.pinLabel}>
                          {isPinned ? t('characters:pinnedShort') : t('characters:pinShort')}
                        </span>
                      </Button>
                      <Button
                        size="sm"
                        disabled={createChat.isPending || continueCharacterChat.isPending}
                        onClick={() => void createNewChat(character.id, character.name)}
                      >
                        <Plus aria-hidden="true" />
                        {t('chat:newChat')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={createChat.isPending || continueCharacterChat.isPending}
                        onClick={() => void openChat(character.id, character.name)}
                      >
                        {t('chat:continueChat')}
                        <ArrowRight aria-hidden="true" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
            {characters.isFetchingNextPage ? (
              <div className={styles.nextPage}>
                <Spinner label={t('common:loading')} />
              </div>
            ) : null}
          </div>
        )}
      </div>
      <CreateCharacterDialog open={createOpen} onOpenChange={setCreateOpen} />
    </ErrorBoundary>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <UserCirclePlus size={52} weight="duotone" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function CreateCharacterDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateCharacter();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (name.trim().length === 0) {
      setCreateError(t('validation:required'));
      return;
    }
    setCreateError(null);
    try {
      await create.mutateAsync({ name, description, personality, firstMessage });
      onOpenChange(false);
      setName('');
      setDescription('');
      setPersonality('');
      setFirstMessage('');
    } catch (error) {
      setCreateError(errorText(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('characters:create')} description={t('characters:createHint')}>
        <div className={styles.form}>
          <TextField
            label={t('characters:name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            error={createError}
          />
          <TextArea
            label={t('characters:description')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <TextArea
            label={t('characters:personality')}
            value={personality}
            onChange={(event) => setPersonality(event.target.value)}
          />
          <TextArea
            label={t('characters:firstMessage')}
            value={firstMessage}
            onChange={(event) => setFirstMessage(event.target.value)}
          />
          <ActionBar
            align="end"
            collapse="stack"
            className={styles.actions}
            data-part="dialog-actions"
          >
            <ActionBarGroup placement="primary">
              <Button onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
              <Button variant="primary" onClick={() => void submit()} disabled={create.isPending}>
                {t('common:create')}
              </Button>
            </ActionBarGroup>
          </ActionBar>
        </div>
      </DialogContent>
    </Dialog>
  );
}
