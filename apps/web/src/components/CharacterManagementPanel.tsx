import {
  ArrowLeft,
  CaretDown,
  Check,
  Copy,
  DownloadSimple,
  Eye,
  Image,
  List,
  MagnifyingGlass,
  Pencil,
  Plus,
  PushPin,
  SquaresFour,
  Star,
  Trash,
  UploadSimple,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import { useCallback, useDeferredValue, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  Character,
  CharacterGalleryImage,
  CharacterSummary,
  PromptAuthoringRole,
} from '@neotavern/contracts';
import {
  ActionBar,
  ActionBarGroup,
  Button,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
} from '@neotavern/ui';
import {
  useCharacter,
  useCharacterGallery,
  useCharacters,
  useContinueCharacterChat,
  useCreateCharacter,
  useCreateLorebook,
  useDeleteCharacter,
  useDeleteCharacterImage,
  useImportCharacter,
  useLorebooks,
  useSettings,
  useUpdateCharacter,
  useUpdateLorebook,
  useUploadCharacterImage,
} from '../api/hooks.js';
import { renderMarkdownDocument } from '../lib/markdown.js';
import { createCreatorNotesPreviewDocument } from '../lib/creatorNotes.js';
import { SlotHost } from '../plugins/slots.js';
import { useErrorText } from '../lib/useErrorText.js';
import { useUiStore } from '../state/ui.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import { FloatingTabContent } from './FloatingTabContent.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import styles from './CharacterManagementPanel.module.css';

type CharacterTab = 'cards' | 'edit' | 'advanced' | 'gallery';
type CharacterSort =
  | 'name'
  | 'name-desc'
  | 'newest'
  | 'oldest'
  | 'favorites'
  | 'used'
  | 'chats-most'
  | 'chats-least'
  | 'tokens-most'
  | 'tokens-least'
  | 'random';
type CharacterView = 'list' | 'grid';
type CharacterEditorMode = 'edit' | 'view';
type PromptRole = PromptAuthoringRole;

interface CharacterManagementPanelProps {
  onClose: () => void;
}

interface CharacterDraft {
  name: string;
  avatar: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogues: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creator: string;
  creatorNotes: string;
  tags: string[];
  favorite: boolean;
  alternateGreetings: string[];
  characterVersion: string;
  characterNote: string;
  characterNoteDepth: number;
  characterNoteRole: PromptRole;
  talkativeness: number;
}

const TABS: readonly CharacterTab[] = ['cards', 'edit', 'advanced', 'gallery'];

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function draftsEqual(left: CharacterDraft, right: CharacterDraft): boolean {
  return (
    left.name === right.name &&
    left.avatar === right.avatar &&
    left.description === right.description &&
    left.personality === right.personality &&
    left.scenario === right.scenario &&
    left.firstMessage === right.firstMessage &&
    left.exampleDialogues === right.exampleDialogues &&
    left.systemPrompt === right.systemPrompt &&
    left.postHistoryInstructions === right.postHistoryInstructions &&
    left.creator === right.creator &&
    left.creatorNotes === right.creatorNotes &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index]) &&
    left.favorite === right.favorite &&
    left.alternateGreetings.length === right.alternateGreetings.length &&
    left.alternateGreetings.every(
      (greeting, index) => greeting === right.alternateGreetings[index],
    ) &&
    left.characterVersion === right.characterVersion &&
    left.characterNote === right.characterNote &&
    left.characterNoteDepth === right.characterNoteDepth &&
    left.characterNoteRole === right.characterNoteRole &&
    left.talkativeness === right.talkativeness
  );
}

function draftToPatch(draft: CharacterDraft) {
  return {
    name: draft.name.trim(),
    avatar: draft.avatar.trim() || null,
    description: draft.description,
    personality: draft.personality,
    scenario: draft.scenario,
    firstMessage: draft.firstMessage,
    exampleDialogues: draft.exampleDialogues,
    systemPrompt: draft.systemPrompt || null,
    postHistoryInstructions: draft.postHistoryInstructions || null,
    creator: draft.creator || null,
    creatorNotes: draft.creatorNotes || null,
    tags: draft.tags,
    ext: {
      favorite: draft.favorite,
      alternateGreetings: draft.alternateGreetings,
      characterVersion: draft.characterVersion,
      depthPrompt: {
        prompt: draft.characterNote,
        depth: draft.characterNoteDepth,
        role: draft.characterNoteRole,
      },
      talkativeness: draft.talkativeness,
    },
  };
}

function characterToDraft(character: Character): CharacterDraft {
  const depthPrompt = objectValue(character.ext['depthPrompt']);
  const role = depthPrompt?.['role'];
  const legacy = objectValue(character.ext['legacy']);
  return {
    name: character.name,
    avatar: character.avatar ?? '',
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    firstMessage: character.firstMessage,
    exampleDialogues: character.exampleDialogues,
    systemPrompt: character.systemPrompt ?? '',
    postHistoryInstructions: character.postHistoryInstructions ?? '',
    creator: character.creator ?? '',
    creatorNotes: character.creatorNotes ?? '',
    tags: character.tags,
    favorite: character.ext['favorite'] === true || legacy?.['favorite'] === true,
    alternateGreetings: Array.isArray(character.ext['alternateGreetings'])
      ? character.ext['alternateGreetings'].filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    characterVersion:
      typeof character.ext['characterVersion'] === 'string'
        ? character.ext['characterVersion']
        : '',
    characterNote: typeof depthPrompt?.['prompt'] === 'string' ? depthPrompt['prompt'] : '',
    characterNoteDepth: Math.max(0, Math.round(numberValue(depthPrompt?.['depth'], 4))),
    characterNoteRole:
      role === 'user' || role === 'assistant' || role === 'system' ? role : 'system',
    talkativeness: Math.min(
      1,
      Math.max(
        0,
        numberValue(character.ext['talkativeness'], numberValue(legacy?.['talkativeness'], 0.5)),
      ),
    ),
  };
}

function CharacterAvatar({
  character,
  className,
  decorative = false,
}: {
  character: Pick<CharacterSummary, 'name' | 'avatar'> | undefined;
  className: string | undefined;
  decorative?: boolean;
}) {
  const { t } = useTranslation();
  if (character?.avatar) {
    return (
      <img
        className={className}
        src={character.avatar}
        alt={decorative ? '' : t('characters:avatarAlt', { name: character.name })}
      />
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {character?.name.slice(0, 1).toLocaleUpperCase() || <UsersThree size={20} />}
    </span>
  );
}

export function CharacterManagementPanel({ onClose }: CharacterManagementPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const pinnedCharacterId = useUiStore((state) => state.pinnedCharacterId);
  const setPinnedCharacterId = useUiStore((state) => state.setPinnedCharacterId);
  const [activeTab, setActiveTab] = useState<CharacterTab>('cards');
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(pinnedCharacterId);
  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput.trim());
  const [sort, setSort] = useState<CharacterSort>('name');
  const [view, setView] = useState<CharacterView>('list');
  const [editorMode, setEditorMode] = useState<CharacterEditorMode>('view');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const continuationRequestRef = useRef(0);

  const characters = useCharacters({
    q: deferredSearch || undefined,
    sort,
    limit: 50,
  });
  const items = characters.data?.pages.flatMap((page) => page.items) ?? [];
  const character = useCharacter(selectedCharacterId ?? undefined);
  const updateCharacter = useUpdateCharacter();
  const continueCharacterChat = useContinueCharacterChat();
  const createCharacter = useCreateCharacter();
  const importCharacter = useImportCharacter();
  const deleteCharacter = useDeleteCharacter();
  const settings = useSettings();

  useEffect(() => {
    if (selectedCharacterId === null && items[0]) setSelectedCharacterId(items[0].id);
  }, [items, selectedCharacterId]);

  useEffect(() => {
    if (!selectedCharacterId) {
      setDraft(null);
      return;
    }
    if (character.data?.id === selectedCharacterId) {
      setDraft(characterToDraft(character.data));
    }
  }, [selectedCharacterId, character.data?.id]);

  const selectedSummary = items.find((item) => item.id === selectedCharacterId) ?? character.data;
  const canEdit = selectedCharacterId !== null;

  const showStatus = (message: string): void => {
    setActionError(null);
    setStatus(message);
  };

  const showError = useCallback(
    (error: unknown): void => {
      setStatus(null);
      setActionError(errorText(error));
    },
    [errorText],
  );

  const selectCharacter = (id: string): void => {
    setSelectedCharacterId(id);
    setPinnedCharacterId(id);
    setStatus(null);
    setActionError(null);
    setEditorMode('view');
  };

  const continueWithCharacter = async (summary: CharacterSummary): Promise<void> => {
    const requestId = ++continuationRequestRef.current;
    try {
      const result = await continueCharacterChat.mutateAsync({
        characterId: summary.id,
        title: summary.name,
        ...(settings.data?.activePersonaId ? { personaId: settings.data.activePersonaId } : {}),
      });
      if (continuationRequestRef.current === requestId) {
        navigate(`/chats/${result.chatId}`);
      }
    } catch (error) {
      if (continuationRequestRef.current === requestId) showError(error);
    }
  };

  const patchDraft = (patch: Partial<CharacterDraft>): void => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setStatus(null);
    setActionError(null);
  };

  const importCard = async (file: File): Promise<void> => {
    showStatus(t('characters:importing'));
    try {
      const result = await importCharacter.mutateAsync(file);
      selectCharacter(result.character.id);
      showStatus(
        result.created
          ? t('characters:importSuccess', { name: result.character.name })
          : t('characters:importExisting', { name: result.character.name }),
      );
      setActiveTab('edit');
    } catch (error) {
      showError(error);
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  useEffect(() => {
    if (!selectedCharacterId || !draft || !character.data) return;
    if (draft.name.trim().length === 0) return;
    if (draftsEqual(draft, characterToDraft(character.data))) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        setActionError(null);
        try {
          const saved = await updateCharacter.mutateAsync({
            id: selectedCharacterId,
            patch: draftToPatch(draft),
          });
          setDraft(characterToDraft(saved));
        } catch (error) {
          showError(error);
        }
      })();
    }, 600);

    return () => window.clearTimeout(timer);
  }, [character.data, draft, selectedCharacterId, showError, updateCharacter]);

  const duplicateSelectedCharacter = async (): Promise<void> => {
    const source = character.data;
    if (!source) return;
    setStatus(null);
    setActionError(null);
    try {
      const created = await createCharacter.mutateAsync({
        name: t('characters:copyName', { name: source.name }),
        avatar: source.avatar,
        description: source.description,
        personality: source.personality,
        scenario: source.scenario,
        firstMessage: source.firstMessage,
        exampleDialogues: source.exampleDialogues,
        systemPrompt: source.systemPrompt,
        postHistoryInstructions: source.postHistoryInstructions,
        creator: source.creator,
        creatorNotes: source.creatorNotes,
        tags: source.tags,
        ext: source.ext,
      });
      selectCharacter(created.id);
      showStatus(t('characters:duplicateSuccess', { name: created.name }));
      setActiveTab('edit');
    } catch (error) {
      showError(error);
    }
  };

  const removeCharacter = async (): Promise<void> => {
    if (!selectedCharacterId) return;
    setActionError(null);
    try {
      await deleteCharacter.mutateAsync(selectedCharacterId);
      if (pinnedCharacterId === selectedCharacterId) setPinnedCharacterId(null);
      setSelectedCharacterId(null);
      setDraft(null);
      setDeleteOpen(false);
      setActiveTab('cards');
      showStatus(t('characters:deleteSuccess'));
    } catch (error) {
      showError(error);
    }
  };

  return (
    <FloatingTabPanel
      component="character-management"
      headerPart="character-management-header"
      avatar={
        <CharacterAvatar character={selectedSummary} className={styles.headerAvatar} decorative />
      }
      title={t('characters:managementTitle')}
      actions={
        <>
          <IconButton
            className={styles.iconButton}
            onClick={() => {
              setActiveTab('edit');
              setEditorMode(activeTab === 'edit' && editorMode === 'view' ? 'edit' : 'view');
            }}
            disabled={!canEdit}
            aria-label={
              activeTab === 'edit' && editorMode === 'view'
                ? t('characters:editCard')
                : t('characters:viewCard')
            }
            title={
              activeTab === 'edit' && editorMode === 'view'
                ? t('characters:editCard')
                : t('characters:viewCard')
            }
          >
            {activeTab === 'edit' && editorMode === 'view' ? (
              <Pencil size={19} aria-hidden="true" />
            ) : (
              <Eye size={19} aria-hidden="true" />
            )}
          </IconButton>
        </>
      }
      onClose={onClose}
    >
      <Tabs
        variant="segment"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as CharacterTab)}
        className={styles.tabs}
        contentClassName={styles.tabPanel}
        scrollable
        scrollMode="root"
        ariaLabel={t('characters:managementTabs')}
        tabs={TABS.map((tab) => ({
          value: tab,
          label: t(`characters:tab_${tab}`),
          disabled: tab !== 'cards' && !canEdit,
          content: (
            <FloatingTabContent>
              {tab === 'cards' ? (
                <CardsTab
                  items={items}
                  selectedCharacterId={selectedCharacterId}
                  pinnedCharacterId={pinnedCharacterId}
                  searchInput={searchInput}
                  sort={sort}
                  view={view}
                  loading={characters.isLoading}
                  loadingMore={characters.isFetchingNextPage}
                  hasMore={characters.hasNextPage}
                  error={characters.isError ? errorText(characters.error) : null}
                  onSearchChange={setSearchInput}
                  onSortChange={setSort}
                  onViewChange={setView}
                  onSelect={(id) => {
                    const summary = items.find((item) => item.id === id);
                    selectCharacter(id);
                    setActiveTab('edit');
                    if (summary) void continueWithCharacter(summary);
                  }}
                  onCreate={() => setCreateOpen(true)}
                  onImport={() => importInputRef.current?.click()}
                  onRetry={() => void characters.refetch()}
                  onLoadMore={() => void characters.fetchNextPage()}
                />
              ) : character.isLoading || !draft ? (
                <PanelLoading />
              ) : character.isError ? (
                <PanelError
                  message={errorText(character.error)}
                  onRetry={() => void character.refetch()}
                />
              ) : tab === 'edit' ? (
                <EditTab
                  characterId={character.data?.id}
                  draft={draft}
                  mode={editorMode}
                  onPatch={patchDraft}
                  onBack={() => setActiveTab('cards')}
                  onDuplicate={() => void duplicateSelectedCharacter()}
                  onDelete={() => setDeleteOpen(true)}
                  onStatus={showStatus}
                  onError={showError}
                />
              ) : tab === 'advanced' ? (
                <AdvancedTab
                  characterId={character.data?.id}
                  characterName={draft.name}
                  draft={draft}
                  onPatch={patchDraft}
                />
              ) : (
                <GalleryTab
                  character={character.data}
                  onAvatarChanged={(avatar) => patchDraft({ avatar })}
                  onStatus={showStatus}
                  onError={showError}
                />
              )}
            </FloatingTabContent>
          ),
        }))}
      />

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

      {status ? (
        <p className={styles.status} role="status">
          {status}
        </p>
      ) : null}
      {actionError ? (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      ) : null}

      <CreateCharacterDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          selectCharacter(created.id);
          setActiveTab('edit');
        }}
      />
      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('characters:deleteTitle')}
        description={t('characters:deleteConfirm', {
          name: character.data?.name ?? draft?.name ?? '',
        })}
        confirmLabel={t('characters:deleteAction')}
        busy={deleteCharacter.isPending}
        danger
        onConfirm={() => void removeCharacter()}
      />
    </FloatingTabPanel>
  );
}

interface CardsTabProps {
  items: CharacterSummary[];
  selectedCharacterId: string | null;
  pinnedCharacterId: string | null;
  searchInput: string;
  sort: CharacterSort;
  view: CharacterView;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onSortChange: (value: CharacterSort) => void;
  onViewChange: (value: CharacterView) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

function CardsTab({
  items,
  selectedCharacterId,
  pinnedCharacterId,
  searchInput,
  sort,
  view,
  loading,
  loadingMore,
  hasMore,
  error,
  onSearchChange,
  onSortChange,
  onViewChange,
  onSelect,
  onCreate,
  onImport,
  onRetry,
  onLoadMore,
}: CardsTabProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.cardsTab} data-part="character-cards">
      <ActionBar
        collapse="compact"
        className={styles.cardToolbar}
        data-part="character-card-toolbar"
      >
        <ActionBarGroup placement="primary">
          <Button variant="primary" startIcon={<Plus aria-hidden="true" />} onClick={onCreate}>
            {t('characters:createShort')}
          </Button>
          <Button startIcon={<UploadSimple aria-hidden="true" />} onClick={onImport}>
            {t('characters:importShort')}
          </Button>
        </ActionBarGroup>
        <label className={styles.sortControl}>
          <span className={styles.srOnly}>{t('characters:sortLabel')}</span>
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value as CharacterSort)}
          >
            <option value="name">{t('characters:sort_name')}</option>
            <option value="name-desc">{t('characters:sort_name_desc')}</option>
            <option value="newest">{t('characters:sort_newest')}</option>
            <option value="oldest">{t('characters:sort_oldest')}</option>
            <option value="favorites">{t('characters:sort_favorites')}</option>
            <option value="used">{t('characters:sort_used')}</option>
            <option value="chats-most">{t('characters:sort_chats_most')}</option>
            <option value="chats-least">{t('characters:sort_chats_least')}</option>
            <option value="tokens-most">{t('characters:sort_tokens_most')}</option>
            <option value="tokens-least">{t('characters:sort_tokens_least')}</option>
            <option value="random">{t('characters:sort_random')}</option>
          </select>
        </label>
      </ActionBar>

      <label className={styles.searchControl}>
        <MagnifyingGlass size={17} aria-hidden="true" />
        <span className={styles.srOnly}>{t('characters:searchPlaceholder')}</span>
        <input
          type="search"
          placeholder={t('characters:searchPlaceholder')}
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>

      <div className={styles.listMeta}>
        <div className={styles.viewToggle} aria-label={t('characters:viewLabel')}>
          <IconButton
            className={styles.iconButton}
            data-state={view === 'list' ? 'active' : 'inactive'}
            onClick={() => onViewChange('list')}
            aria-label={t('characters:viewList')}
            aria-pressed={view === 'list'}
          >
            <List size={17} aria-hidden="true" />
          </IconButton>
          <IconButton
            className={styles.iconButton}
            data-state={view === 'grid' ? 'active' : 'inactive'}
            onClick={() => onViewChange('grid')}
            aria-label={t('characters:viewGrid')}
            aria-pressed={view === 'grid'}
          >
            <SquaresFour size={17} aria-hidden="true" />
          </IconButton>
        </div>
        <span>{t('characters:loadedCount', { count: items.length })}</span>
      </div>

      {loading ? (
        <PanelLoading />
      ) : error ? (
        <PanelError message={error} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <UsersThree size={32} aria-hidden="true" />
          <strong>
            {searchInput ? t('characters:noResultsTitle') : t('characters:emptyTitle')}
          </strong>
          <p>
            {searchInput ? t('characters:noResultsDescription') : t('characters:emptyDescription')}
          </p>
        </div>
      ) : (
        <div className={styles.characterList} data-view={view}>
          {items.map((item) => {
            const selected = item.id === selectedCharacterId;
            const pinned = item.id === pinnedCharacterId;
            return (
              <button
                type="button"
                key={item.id}
                className={styles.characterCard}
                data-state={selected ? 'selected' : 'idle'}
                data-pinned={pinned ? 'true' : 'false'}
                onClick={() => onSelect(item.id)}
                aria-pressed={selected}
              >
                <CharacterAvatar character={item} className={styles.cardAvatar} />
                <span className={styles.cardCopy}>
                  <strong>{item.name}</strong>
                  <span>{item.description || t('characters:noDescription')}</span>
                  {item.tags.length > 0 ? (
                    <span className={styles.tags}>
                      {item.tags.slice(0, 3).map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </span>
                  ) : null}
                </span>
                {pinned ? (
                  <PushPin
                    className={styles.pinnedIcon}
                    weight="fill"
                    aria-label={t('characters:pinnedShort')}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {hasMore ? (
        <Button className={styles.loadMore} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t('common:loading') : t('common:loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function EditTab({
  characterId,
  draft,
  mode,
  onPatch,
  onBack,
  onDuplicate,
  onDelete,
  onStatus,
  onError,
}: {
  characterId: string | undefined;
  draft: CharacterDraft;
  mode: CharacterEditorMode;
  onPatch: (patch: Partial<CharacterDraft>) => void;
  onBack: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onStatus: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const uploadImage = useUploadCharacterImage();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [expandedGreeting, setExpandedGreeting] = useState<number | null>(null);
  const [tagInput, setTagInput] = useState('');

  if (mode === 'view') {
    return <CharacterCardViewer characterId={characterId} draft={draft} />;
  }

  const uploadAvatar = async (file: File): Promise<void> => {
    if (!characterId) return;
    try {
      const image = await uploadImage.mutateAsync({ characterId, file });
      onPatch({ avatar: image.thumbnailUrl });
      onStatus(t('characters:imageUploadSuccess', { name: image.name }));
    } catch (error) {
      onError(error);
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const updateGreeting = (index: number, value: string): void => {
    onPatch({
      alternateGreetings: draft.alternateGreetings.map((greeting, current) =>
        current === index ? value : greeting,
      ),
    });
  };

  const addGreeting = (): void => {
    const nextIndex = draft.alternateGreetings.length;
    onPatch({ alternateGreetings: [...draft.alternateGreetings, ''] });
    setExpandedGreeting(nextIndex);
  };

  const removeGreeting = (index: number): void => {
    onPatch({
      alternateGreetings: draft.alternateGreetings.filter((_value, current) => current !== index),
    });
    setExpandedGreeting((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  };

  const addTag = (): void => {
    const value = tagInput.trim();
    if (!value) return;
    const duplicate = draft.tags.some(
      (tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase(),
    );
    if (!duplicate) onPatch({ tags: [...draft.tags, value] });
    setTagInput('');
  };

  return (
    <div className={styles.editor} data-part="character-editor">
      <div className={styles.characterActionBar}>
        <IconButton
          className={styles.iconButton}
          onClick={onBack}
          aria-label={t('characters:backToCards')}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </IconButton>
        <span className={styles.actionBarSpacer} />
        <IconButton
          className={styles.iconButton}
          data-state={draft.favorite ? 'active' : 'inactive'}
          onClick={() => onPatch({ favorite: !draft.favorite })}
          aria-label={draft.favorite ? t('characters:removeFavorite') : t('characters:addFavorite')}
          aria-pressed={draft.favorite}
        >
          <Star size={18} weight={draft.favorite ? 'fill' : 'regular'} aria-hidden="true" />
        </IconButton>
        {characterId ? <ExportMenu characterId={characterId} /> : null}
        <IconButton
          className={styles.iconButton}
          onClick={onDuplicate}
          aria-label={t('characters:duplicate')}
        >
          <Copy size={18} aria-hidden="true" />
        </IconButton>
        <IconButton
          className={styles.iconButton}
          onClick={onDelete}
          aria-label={t('characters:deleteAction')}
        >
          <Trash size={18} aria-hidden="true" />
        </IconButton>
        <SlotHost slot="character.editor.actions" context={{ characterId: characterId ?? null }} />
      </div>

      <section className={styles.identity}>
        <button
          type="button"
          className={styles.avatarButton}
          onClick={() => avatarInputRef.current?.click()}
          aria-label={t('characters:changeAvatar')}
        >
          <CharacterAvatar
            character={{ name: draft.name, avatar: draft.avatar || null }}
            className={styles.editorAvatar}
          />
          <span>
            <Pencil size={11} aria-hidden="true" />
          </span>
        </button>
        <div>
          <h3>{draft.name || t('characters:unnamed')}</h3>
          <p>{t('characters:editIdentityHint')}</p>
        </div>
      </section>
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadAvatar(file);
        }}
      />

      <EditorField
        label={t('characters:name')}
        value={draft.name}
        onChange={(value) => onPatch({ name: value })}
        required
      />
      <EditorField
        label={t('characters:creatorNotes')}
        value={draft.creatorNotes}
        onChange={(value) => onPatch({ creatorNotes: value })}
        multiline
      />
      <EditorField
        label={t('characters:description')}
        value={draft.description}
        onChange={(value) => onPatch({ description: value })}
        multiline
        tall
      />
      <EditorField
        label={t('characters:firstMessage')}
        value={draft.firstMessage}
        onChange={(value) => onPatch({ firstMessage: value })}
        multiline
        tall
      />

      <section className={styles.greetings}>
        <div className={styles.subsectionHeader}>
          <div>
            <strong>{t('characters:alternateGreetings')}</strong>
            <small>{t('characters:alternateGreetingsHint')}</small>
          </div>
          <Button size="sm" onClick={addGreeting}>
            {t('common:add')}
          </Button>
        </div>
        {draft.alternateGreetings.length === 0 ? (
          <p className={styles.inlineEmpty}>{t('characters:noAlternateGreetings')}</p>
        ) : (
          draft.alternateGreetings.map((greeting, index) => {
            const expanded = expandedGreeting === index;
            return (
              <div
                className={styles.greetingItem}
                key={index}
                data-state={expanded ? 'open' : 'closed'}
              >
                <div className={styles.greetingHeader}>
                  <button
                    type="button"
                    className={styles.greetingToggle}
                    onClick={() => setExpandedGreeting(expanded ? null : index)}
                    aria-expanded={expanded}
                  >
                    <CaretDown size={15} aria-hidden="true" />
                    <span>
                      <strong>{t('characters:alternateGreeting', { index: index + 1 })}</strong>
                      <small>
                        {t('characters:approxTokens', {
                          count: Math.ceil(greeting.length / 4),
                        })}
                      </small>
                    </span>
                  </button>
                  <IconButton
                    className={styles.compactIconButton}
                    onClick={() => removeGreeting(index)}
                    aria-label={t('characters:removeAlternateGreeting', { index: index + 1 })}
                  >
                    <Trash size={15} aria-hidden="true" />
                  </IconButton>
                </div>
                {expanded ? (
                  <EditorField
                    label={t('characters:alternateGreeting', { index: index + 1 })}
                    value={greeting}
                    onChange={(value) => updateGreeting(index, value)}
                    multiline
                    hideHeading
                  />
                ) : null}
              </div>
            );
          })
        )}
      </section>

      <section className={styles.tagEditor}>
        <strong>{t('characters:tags')}</strong>
        <div className={styles.tagInputRow}>
          <input
            type="text"
            value={tagInput}
            placeholder={t('characters:tagsHint')}
            aria-label={t('characters:tagInput')}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addTag();
            }}
          />
          <Button size="sm" onClick={addTag} disabled={!tagInput.trim()}>
            <Plus size={15} aria-hidden="true" />
            {t('characters:addTag')}
          </Button>
        </div>
        {draft.tags.length > 0 ? (
          <div className={styles.tagChips} aria-label={t('characters:assignedTags')}>
            {draft.tags.map((tag) => (
              <span key={tag}>
                {tag}
                <button
                  type="button"
                  onClick={() => onPatch({ tags: draft.tags.filter((item) => item !== tag) })}
                  aria-label={t('characters:removeTag', { tag })}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <small className={styles.inlineEmpty}>{t('characters:noTags')}</small>
        )}
      </section>
    </div>
  );
}

function CharacterCardViewer({
  characterId,
  draft,
}: {
  characterId: string | undefined;
  draft: CharacterDraft;
}) {
  const { t } = useTranslation();
  const authoredPresentation = draft.creatorNotes.trim();
  const greetings = [draft.firstMessage, ...draft.alternateGreetings].filter((value) =>
    value.trim(),
  );
  const avatarOriginalUrl =
    characterId && draft.avatar
      ? `/api/v2/characters/${characterId}/avatar-original`
      : draft.avatar;
  const characterName = draft.name || t('characters:unnamed');
  return (
    <div
      className={styles.viewer}
      data-component="character-card-viewer"
      data-part="character-viewer"
      data-state="read-only"
    >
      <section className={styles.viewerIdentity} data-part="character-viewer-identity">
        {avatarOriginalUrl ? (
          <img
            className={styles.viewerAvatar}
            src={avatarOriginalUrl}
            alt={t('characters:avatarAlt', { name: characterName })}
          />
        ) : (
          <CharacterAvatar
            character={{ name: draft.name, avatar: null }}
            className={styles.viewerAvatarFallback}
          />
        )}
        <div className={styles.viewerIdentityCopy}>
          <h2>{characterName}</h2>
          <div className={styles.viewerTags} data-part="character-viewer-tags">
            {draft.tags.length > 0 ? (
              draft.tags.map((tag) => <span key={tag}>{tag}</span>)
            ) : (
              <small>{t('characters:noTags')}</small>
            )}
          </div>
        </div>
      </section>
      {authoredPresentation ? (
        <CreatorNotesPreview
          title={t('characters:viewCardTitle', { name: characterName })}
          value={draft.creatorNotes}
        />
      ) : null}
      <div className={styles.viewerDisclosures} data-part="character-viewer-details">
        {draft.description.trim() ? (
          <MarkdownDisclosure label={t('characters:description')} value={draft.description} />
        ) : null}
        {greetings.length > 0 ? (
          <details className={styles.viewerDisclosure} data-part="character-viewer-greetings">
            <summary>{t('characters:greetings')}</summary>
            <div className={styles.viewerGreetingList}>
              {greetings.map((greeting, index) => (
                <MarkdownDisclosure
                  key={index}
                  label={
                    index === 0
                      ? t('characters:firstMessage')
                      : t('characters:alternateGreetingPreview', { index })
                  }
                  value={greeting}
                  part="character-viewer-greeting"
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function CreatorNotesPreview({ title, value }: { title: string; value: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const previewDocument = createCreatorNotesPreviewDocument(value);

  useEffect(() => {
    return () => resizeObserverRef.current?.disconnect();
  }, []);

  useEffect(() => {
    frameRef.current?.setAttribute('scrolling', 'no');
  });

  const syncFrameHeight = (): void => {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    const previewRoot = document.querySelector<HTMLElement>('[data-character-preview-root]');
    const root = previewRoot ?? document.body;
    const rootTop = root.getBoundingClientRect().top;
    const window = document.defaultView;
    const inFlowChildren = Array.from(root.children).filter((element) => {
      const position = window?.getComputedStyle(element).position;
      return position !== 'absolute' && position !== 'fixed';
    });
    const contentHeight = Math.max(
      1,
      ...inFlowChildren.map((element) => element.getBoundingClientRect().bottom - rootTop),
    );
    const height = Math.ceil(contentHeight) + 1;
    setFrameHeight((current) => (current === height ? current : height));
  };

  const handleFrameLoad = (): void => {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    resizeObserverRef.current?.disconnect();
    syncFrameHeight();
    frameRef.current?.contentWindow?.requestAnimationFrame(syncFrameHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncFrameHeight);
    const previewRoot = document.querySelector('[data-character-preview-root]') ?? document.body;
    observer.observe(previewRoot);
    for (const element of Array.from(previewRoot.children)) {
      observer.observe(element);
    }
    resizeObserverRef.current = observer;
  };

  return (
    <iframe
      ref={frameRef}
      className={styles.viewerFrame}
      data-part="character-viewer-creator-notes"
      title={title}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={previewDocument}
      style={frameHeight === null ? undefined : { height: `${frameHeight}px` }}
      onLoad={handleFrameLoad}
    />
  );
}

function MarkdownDisclosure({
  label,
  value,
  part = 'character-viewer-description',
}: {
  label: string;
  value: string;
  part?: string;
}) {
  return (
    <details className={styles.viewerDisclosure} data-part={part}>
      <summary>{label}</summary>
      <MarkdownContent value={value} />
    </details>
  );
}

function MarkdownContent({ value }: { value: string }) {
  return (
    <div
      className={styles.viewerMarkdown}
      dangerouslySetInnerHTML={{
        __html: renderMarkdownDocument(value, { articleClass: 'character-card-markdown' }),
      }}
    />
  );
}

/* Creator-notes HTML sanitization/rendering lives in lib/creatorNotes.ts
   (ARCH-14): security-boundary code must be reviewable and unit-testable
   outside this component. */

function ExportMenu({ characterId }: { characterId: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton className={styles.iconButton} aria-label={t('characters:export')}>
          <DownloadSimple size={18} aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={`/api/v2/characters/${characterId}/export?format=png`}>
            <strong>PNG</strong>
            <small>{t('characters:exportPngHint')}</small>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`/api/v2/characters/${characterId}/export?format=json`}>
            <strong>JSON</strong>
            <small>{t('characters:exportJsonHint')}</small>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AdvancedTab({
  characterId,
  characterName,
  draft,
  onPatch,
}: {
  characterId: string | undefined;
  characterName: string;
  draft: CharacterDraft;
  onPatch: (patch: Partial<CharacterDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.editor} data-part="character-advanced">
      <div className={styles.sectionHeading}>
        <h3>{t('characters:advancedTitle', { name: characterName })}</h3>
        <p>{t('characters:advancedHint')}</p>
      </div>

      <details className={styles.advancedSection}>
        <summary>{t('characters:promptOverrides')}</summary>
        <div className={styles.advancedSectionBody}>
          <p>{t('characters:promptOverridesHint')}</p>
          <EditorField
            label={t('characters:systemPrompt')}
            value={draft.systemPrompt}
            onChange={(value) => onPatch({ systemPrompt: value })}
            multiline
          />
          <EditorField
            label={t('characters:postHistoryInstructions')}
            value={draft.postHistoryInstructions}
            onChange={(value) => onPatch({ postHistoryInstructions: value })}
            multiline
          />
        </div>
      </details>

      <details className={styles.advancedSection}>
        <summary>{t('characters:creatorMetadata')}</summary>
        <div className={styles.advancedSectionBody}>
          <p>{t('characters:creatorMetadataHint')}</p>
          <EditorField
            label={t('characters:creator')}
            value={draft.creator}
            onChange={(value) => onPatch({ creator: value })}
          />
          <EditorField
            label={t('characters:characterVersion')}
            value={draft.characterVersion}
            onChange={(value) => onPatch({ characterVersion: value })}
          />
        </div>
      </details>

      <EditorField
        label={t('characters:personalitySummary')}
        value={draft.personality}
        onChange={(value) => onPatch({ personality: value })}
        placeholder={t('characters:personalityHint')}
        multiline
      />
      <EditorField
        label={t('characters:scenario')}
        value={draft.scenario}
        onChange={(value) => onPatch({ scenario: value })}
        placeholder={t('characters:scenarioHint')}
        multiline
      />

      <section className={styles.noteSection}>
        <EditorField
          label={t('characters:characterNote')}
          value={draft.characterNote}
          onChange={(value) => onPatch({ characterNote: value })}
          placeholder={t('characters:characterNoteHint')}
          multiline
        />
        <div className={styles.noteControls}>
          <label className={styles.compactField}>
            <span>{t('characters:depth')}</span>
            <input
              type="number"
              min={0}
              max={9999}
              value={draft.characterNoteDepth}
              onChange={(event) =>
                onPatch({
                  characterNoteDepth: Math.max(0, Math.min(9999, Number(event.target.value) || 0)),
                })
              }
            />
          </label>
          <label className={styles.compactField}>
            <span>{t('characters:role')}</span>
            <select
              value={draft.characterNoteRole}
              onChange={(event) => onPatch({ characterNoteRole: event.target.value as PromptRole })}
            >
              <option value="system">{t('characters:role_system')}</option>
              <option value="user">{t('characters:role_user')}</option>
              <option value="assistant">{t('characters:role_assistant')}</option>
            </select>
          </label>
        </div>
      </section>

      <label className={styles.rangeField}>
        <span className={styles.fieldHeading}>
          <strong>{t('characters:talkativeness')}</strong>
          <small>{Math.round(draft.talkativeness * 100)}%</small>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={draft.talkativeness}
          onChange={(event) => onPatch({ talkativeness: Number(event.target.value) })}
        />
        <span className={styles.rangeLabels}>
          <small>{t('characters:talkativenessShy')}</small>
          <small>{t('characters:talkativenessNormal')}</small>
          <small>{t('characters:talkativenessChatty')}</small>
        </span>
      </label>

      <EditorField
        label={t('characters:exampleDialogues')}
        value={draft.exampleDialogues}
        onChange={(value) => onPatch({ exampleDialogues: value })}
        placeholder={t('characters:exampleDialoguesHint')}
        multiline
        tall
      />

      <details className={styles.advancedSection} open>
        <summary>{t('characters:lorebooksSection')}</summary>
        <div className={styles.advancedSectionBody}>
          <CharacterLorebooks characterId={characterId} characterName={characterName} />
        </div>
      </details>
    </div>
  );
}

function CharacterLorebooks({
  characterId,
  characterName,
}: {
  characterId: string | undefined;
  characterName: string;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const openSidebarPanel = useUiStore((state) => state.openSidebarPanel);
  const books = useLorebooks(characterId ? { characterId, limit: 200 } : { limit: 200 });
  const updateBook = useUpdateLorebook();
  const createBook = useCreateLorebook();
  const [createBusy, setCreateBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  if (!characterId) return null;

  const linkedBooks =
    books.data?.pages
      .flatMap((page) => page.items)
      .filter((book) => book.characterId === characterId) ?? [];

  const createForCharacter = async (): Promise<void> => {
    setPanelError(null);
    setCreateBusy(true);
    try {
      await createBook.mutateAsync({
        name: t('lorebooks:defaultName'),
        characterId,
      });
      openSidebarPanel('lorebooks');
    } catch (error) {
      setPanelError(errorText(error));
    } finally {
      setCreateBusy(false);
    }
  };

  const unlinkBook = async (bookId: string): Promise<void> => {
    setPanelError(null);
    try {
      await updateBook.mutateAsync({ id: bookId, update: { characterId: null } });
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  return (
    <div className={styles.lorebookList} data-component="character-lorebooks">
      <p className={styles.lorebookHint}>{t('characters:lorebooksSectionHint')}</p>
      <div className={styles.lorebookActions}>
        <Button
          size="sm"
          disabled={createBusy}
          startIcon={<Plus aria-hidden="true" />}
          onClick={() => void createForCharacter()}
        >
          {t('characters:lorebooksNewForCharacter', { name: characterName })}
        </Button>
        <Button size="sm" onClick={() => openSidebarPanel('lorebooks')}>
          {t('characters:lorebooksOpenManager')}
        </Button>
      </div>
      {linkedBooks.length === 0 ? (
        <p className={styles.lorebookHint}>{t('characters:lorebooksEmpty')}</p>
      ) : (
        <ul className={styles.lorebookList}>
          {linkedBooks.map((book) => (
            <li key={book.id} className={styles.lorebookRow}>
              <span className={styles.lorebookName}>{book.name}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={updateBook.isPending}
                onClick={() => void unlinkBook(book.id)}
              >
                {t('characters:lorebooksUnlink')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {panelError ? (
        <p className={styles.lorebookError} role="alert">
          {panelError}
        </p>
      ) : null}
    </div>
  );
}

function GalleryTab({
  character,
  onAvatarChanged,
  onStatus,
  onError,
}: {
  character: Character | undefined;
  onAvatarChanged: (avatar: string) => void;
  onStatus: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [sort, setSort] = useState<'oldest' | 'newest'>('oldest');
  const [columns, setColumns] = useState<1 | 2 | 3 | 4>(3);
  const [deleteImage, setDeleteImage] = useState<CharacterGalleryImage | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const gallery = useCharacterGallery(character?.id, sort);
  const uploadImage = useUploadCharacterImage();
  const removeImage = useDeleteCharacterImage();
  const updateCharacter = useUpdateCharacter();

  if (!character) return null;
  const items = gallery.data?.items ?? [];
  const avatarIsGalleryImage = items.some((item) => item.thumbnailUrl === character.avatar);

  const setPrimary = async (image: CharacterGalleryImage): Promise<void> => {
    try {
      await updateCharacter.mutateAsync({
        id: character.id,
        patch: { avatar: image.thumbnailUrl },
      });
      onAvatarChanged(image.thumbnailUrl);
      onStatus(t('characters:primaryImageSuccess', { name: image.name }));
    } catch (error) {
      onError(error);
    }
  };

  const uploadFiles = async (files: FileList): Promise<void> => {
    try {
      let firstUploaded: CharacterGalleryImage | null = null;
      for (const file of Array.from(files)) {
        const uploaded = await uploadImage.mutateAsync({ characterId: character.id, file });
        firstUploaded ??= uploaded;
      }
      if (!character.avatar && firstUploaded) await setPrimary(firstUploaded);
      onStatus(t('characters:galleryUploadSuccess', { count: files.length }));
    } catch (error) {
      onError(error);
    } finally {
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const confirmDeleteImage = async (): Promise<void> => {
    if (!deleteImage) return;
    try {
      if (character.avatar === deleteImage.thumbnailUrl) {
        await updateCharacter.mutateAsync({ id: character.id, patch: { avatar: null } });
        onAvatarChanged('');
      }
      await removeImage.mutateAsync({
        characterId: character.id,
        imageId: deleteImage.id,
      });
      onStatus(t('characters:galleryDeleteSuccess', { name: deleteImage.name }));
      setDeleteImage(null);
    } catch (error) {
      onError(error);
    }
  };

  return (
    <div className={styles.gallery} data-part="character-gallery">
      <div className={styles.galleryToolbar}>
        <div className={styles.galleryHeading} data-part="gallery-heading">
          <h3>{t('characters:galleryTitle')}</h3>
          <p>{t('characters:galleryHint')}</p>
        </div>
        <div className={styles.galleryControls} data-part="gallery-controls">
          <label className={styles.sortControl}>
            <span className={styles.srOnly}>{t('characters:galleryColumns')}</span>
            <select
              value={columns}
              onChange={(event) => setColumns(Number(event.target.value) as 1 | 2 | 3 | 4)}
            >
              <option value={1}>{t('characters:galleryColumns_one')}</option>
              <option value={2}>{t('characters:galleryColumns_other', { count: 2 })}</option>
              <option value={3}>{t('characters:galleryColumns_other', { count: 3 })}</option>
              <option value={4}>{t('characters:galleryColumns_other', { count: 4 })}</option>
            </select>
          </label>
          <label className={styles.sortControl}>
            <span className={styles.srOnly}>{t('characters:gallerySort')}</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as 'oldest' | 'newest')}
            >
              <option value="oldest">{t('characters:gallerySort_oldest')}</option>
              <option value="newest">{t('characters:gallerySort_newest')}</option>
            </select>
          </label>
          <Button size="sm" onClick={() => uploadInputRef.current?.click()}>
            <Plus aria-hidden="true" />
            {t('characters:addImage')}
          </Button>
        </div>
      </div>
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void uploadFiles(event.target.files);
        }}
      />

      {gallery.isLoading ? (
        <PanelLoading />
      ) : gallery.isError ? (
        <PanelError message={errorText(gallery.error)} onRetry={() => void gallery.refetch()} />
      ) : items.length === 0 && !character.avatar ? (
        <div className={styles.emptyState}>
          <Image size={34} aria-hidden="true" />
          <strong>{t('characters:galleryEmptyTitle')}</strong>
          <p>{t('characters:galleryEmptyHint')}</p>
          <Button onClick={() => uploadInputRef.current?.click()}>
            <Plus aria-hidden="true" />
            {t('characters:addImage')}
          </Button>
        </div>
      ) : (
        <div className={styles.galleryGrid} data-columns={columns}>
          {character.avatar && !avatarIsGalleryImage ? (
            <GalleryFigure
              name={character.name}
              thumbnailUrl={character.avatar}
              originalUrl={`/api/v2/characters/${character.id}/avatar-original`}
              primary
            />
          ) : null}
          {items.map((item) => (
            <GalleryFigure
              key={item.id}
              name={item.name}
              thumbnailUrl={item.thumbnailUrl}
              originalUrl={item.originalUrl}
              primary={character.avatar === item.thumbnailUrl}
              onPrimary={() => void setPrimary(item)}
              onDelete={() => setDeleteImage(item)}
            />
          ))}
        </div>
      )}

      <ConfirmActionDialog
        open={deleteImage !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteImage(null);
        }}
        title={t('characters:deleteImageTitle')}
        description={t('characters:deleteImageConfirm', { name: deleteImage?.name ?? '' })}
        confirmLabel={t('characters:deleteImageAction')}
        busy={removeImage.isPending || updateCharacter.isPending}
        danger
        onConfirm={() => void confirmDeleteImage()}
      />
    </div>
  );
}

function GalleryFigure({
  name,
  thumbnailUrl,
  originalUrl,
  primary,
  onPrimary,
  onDelete,
}: {
  name: string;
  thumbnailUrl: string;
  originalUrl: string;
  primary: boolean;
  onPrimary?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <figure className={styles.galleryItem} data-state={primary ? 'primary' : 'default'}>
      <a href={originalUrl} target="_blank" rel="noreferrer">
        <img src={thumbnailUrl} alt={name} loading="lazy" />
      </a>
      <figcaption>
        <span>
          <strong title={name}>{name}</strong>
          <small>{primary ? t('characters:primaryAvatar') : t('characters:galleryImage')}</small>
        </span>
        <span className={styles.galleryActions}>
          {primary ? (
            <Check size={17} aria-label={t('characters:primaryAvatar')} />
          ) : onPrimary ? (
            <IconButton
              className={styles.iconButton}
              onClick={onPrimary}
              aria-label={t('characters:setPrimaryImage', { name })}
            >
              <Check size={17} aria-hidden="true" />
            </IconButton>
          ) : null}
          {onDelete ? (
            <IconButton
              className={styles.iconButton}
              onClick={onDelete}
              aria-label={t('characters:deleteImageNamed', { name })}
            >
              <Trash size={17} aria-hidden="true" />
            </IconButton>
          ) : null}
        </span>
      </figcaption>
    </figure>
  );
}

function EditorField({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  tall = false,
  required = false,
  hideHeading = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  tall?: boolean;
  required?: boolean;
  hideHeading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label className={styles.editorField}>
      {hideHeading ? (
        <span className={styles.srOnly}>{label}</span>
      ) : (
        <span className={styles.fieldHeading}>
          <strong>{label}</strong>
          {multiline ? (
            <small>{t('characters:approxTokens', { count: Math.ceil(value.length / 4) })}</small>
          ) : null}
        </span>
      )}
      {multiline ? (
        <textarea
          className={tall ? styles.textareaTall : styles.textarea}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          required={required}
        />
      ) : (
        <input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          required={required}
        />
      )}
    </label>
  );
}

function PanelLoading() {
  const { t } = useTranslation();
  return (
    <div className={styles.loading} aria-label={t('common:loading')}>
      <Skeleton className={styles.loadingItem} />
      <Skeleton className={styles.loadingItem} />
      <Skeleton className={styles.loadingItem} />
    </div>
  );
}

function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.emptyState} role="alert">
      <strong>{t('characters:errorTitle')}</strong>
      <p>{message}</p>
      <Button onClick={onRetry}>{t('common:retry')}</Button>
    </div>
  );
}

function CreateCharacterDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (character: Character) => void;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const create = useCreateCharacter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) {
      setError(t('validation:required'));
      return;
    }
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        description,
        firstMessage,
      });
      onCreated(created);
      onOpenChange(false);
      setName('');
      setDescription('');
      setFirstMessage('');
    } catch (submitError) {
      setError(errorText(submitError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('characters:create')} description={t('characters:createHint')}>
        <form className={styles.createForm} onSubmit={(event) => void submit(event)}>
          <TextField
            label={t('characters:name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={error}
            required
          />
          <TextArea
            label={t('characters:description')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <TextArea
            label={t('characters:firstMessage')}
            value={firstMessage}
            onChange={(event) => setFirstMessage(event.target.value)}
          />
          <div className={styles.dialogActions}>
            <Button onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
            <Button variant="primary" type="submit" disabled={create.isPending}>
              {create.isPending ? t('characters:creating') : t('common:create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
