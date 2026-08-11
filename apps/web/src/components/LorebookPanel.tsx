import {
  BookOpenText,
  Check,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lorebook, LorebookEntry } from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';
import {
  ActionBar,
  ActionBarGroup,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Switch,
  Tabs,
  TextField,
} from '@neotavern/ui';
import {
  useCharacter,
  useCharacters,
  useCreateLorebook,
  useCreateLorebookEntry,
  useDeleteLorebook,
  useDeleteLorebookEntry,
  useLorebook,
  useLorebookEntries,
  useLorebooks,
  useUpdateLorebook,
  useUpdateLorebookEntry,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import { FloatingTabContent } from './FloatingTabContent.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import styles from './LorebookPanel.module.css';

const DESCRIPTION_SAVE_MS = 600;
const PICKER_DEBOUNCE_MS = 250;
const LOREBOK_TABS = ['books', 'book', 'entries'] as const;
type LorebookTab = (typeof LOREBOK_TABS)[number];

type BookScope = 'all' | 'global' | 'character';

interface LorebookPanelProps {
  onClose: () => void;
}

export function LorebookPanel({ onClose }: LorebookPanelProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();

  const [activeTab, setActiveTab] = useState<LorebookTab>('books');
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [scope, setScope] = useState<BookScope>('all');
  const [scopeCharacterId, setScopeCharacterId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scopeQuery = useMemo(
    () => (scope === 'character' && scopeCharacterId ? { characterId: scopeCharacterId } : {}),
    [scope, scopeCharacterId],
  );
  const booksQuery = useLorebooks({ ...scopeQuery, limit: 200 });
  const allBooks = useMemo(
    () => booksQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [booksQuery.data],
  );

  const detailBook = useLorebook(selectedBookId ?? undefined);
  const selectedBook =
    detailBook.data ?? allBooks.find((book) => book.id === selectedBookId) ?? null;
  const entriesQuery = useLorebookEntries(selectedBookId ?? undefined);

  const createBook = useCreateLorebook();
  const updateBook = useUpdateLorebook();
  const deleteBook = useDeleteLorebook();

  const busy = createBook.isPending || updateBook.isPending || deleteBook.isPending;

  const filteredBooks = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const byScope =
      scope === 'global' ? allBooks.filter((book) => book.characterId === null) : allBooks;
    return query
      ? byScope.filter((book) => book.name.toLocaleLowerCase().includes(query))
      : byScope;
  }, [allBooks, scope, searchQuery]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'books') setSelectedBookId(null);
  }, [activeTab]);

  const selectBook = (book: Lorebook): void => {
    setSelectedBookId(book.id);
    setPanelError(null);
    setActiveTab('book');
  };

  const handleCreate = async (): Promise<void> => {
    const name = createName.trim() || t('lorebooks:defaultName');
    setPanelError(null);
    try {
      const created = await createBook.mutateAsync({ name });
      setCreateOpen(false);
      setCreateName('');
      selectBook(created);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const handleDeleteBook = async (): Promise<void> => {
    if (!selectedBook) return;
    setPanelError(null);
    try {
      await deleteBook.mutateAsync(selectedBook.id);
      setDeleteOpen(false);
      setSelectedBookId(null);
      setActiveTab('books');
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const updateSelectedBook = async (update: {
    name?: string;
    description?: string;
    characterId?: string | null;
  }): Promise<void> => {
    if (!selectedBook) return;
    setPanelError(null);
    try {
      await updateBook.mutateAsync({ id: selectedBook.id, update });
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  return (
    <FloatingTabPanel
      component="lorebooks-panel"
      headerPart="lorebooks-header"
      avatar={
        <span className={styles.headerAvatar} aria-hidden="true">
          <BookOpenText size={20} />
        </span>
      }
      title={t('lorebooks:managementTitle')}
      onClose={onClose}
    >
      <Tabs
        variant="segment"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as LorebookTab)}
        className={styles.tabs}
        contentClassName={styles.tabPanel}
        scrollable
        scrollMode="root"
        ariaLabel={t('lorebooks:managementTabs')}
        tabs={LOREBOK_TABS.map((tab) => ({
          value: tab,
          label: t(`lorebooks:tab_${tab}`),
          disabled: tab !== 'books' && selectedBookId === null,
          content: (
            <FloatingTabContent>
              {tab === 'books' ? (
                <BooksTab
                  items={filteredBooks}
                  totalLoaded={allBooks.length}
                  loading={booksQuery.isLoading}
                  isFetching={booksQuery.isFetching}
                  error={booksQuery.isError ? errorText(booksQuery.error) : null}
                  searchQuery={searchQuery}
                  scope={scope}
                  scopeCharacterId={scopeCharacterId}
                  hasNextPage={booksQuery.hasNextPage}
                  onSearchChange={setSearchQuery}
                  onScopeChange={(next, characterId) => {
                    setScope(next);
                    setScopeCharacterId(characterId);
                  }}
                  onSelect={selectBook}
                  onCreate={() => {
                    setCreateName('');
                    setCreateOpen(true);
                  }}
                  onLoadMore={() => void booksQuery.fetchNextPage()}
                  onRetry={() => void booksQuery.refetch()}
                />
              ) : selectedBook && tab === 'book' ? (
                <BookTab
                  book={selectedBook}
                  busy={busy}
                  onNameSave={(name) => void updateSelectedBook({ name })}
                  onDescriptionSave={(description) => void updateSelectedBook({ description })}
                  onCharacterChange={(characterId) => void updateSelectedBook({ characterId })}
                  onDelete={() => setDeleteOpen(true)}
                  onBack={() => setActiveTab('books')}
                  onOpenEntries={() => setActiveTab('entries')}
                />
              ) : selectedBook ? (
                <EntriesTab
                  book={selectedBook}
                  entries={entriesQuery.data?.items ?? []}
                  loading={entriesQuery.isLoading}
                  error={entriesQuery.isError ? errorText(entriesQuery.error) : null}
                  onRetry={() => void entriesQuery.refetch()}
                  onBack={() => setActiveTab('book')}
                />
              ) : null}
            </FloatingTabContent>
          ),
        }))}
      />

      {panelError ? (
        <p className={styles.error} role="alert">
          {panelError}
        </p>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent title={t('lorebooks:createTitle')} description={t('lorebooks:createHint')}>
          <TextField
            label={t('lorebooks:nameLabel')}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder={t('lorebooks:defaultName')}
            autoFocus
          />
          <div className={styles.dialogActions}>
            <DialogClose asChild>
              <Button disabled={createBook.isPending}>{t('common:cancel')}</Button>
            </DialogClose>
            <Button disabled={createBook.isPending} onClick={() => void handleCreate()}>
              {t('common:create')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('lorebooks:deleteTitle')}
        description={t('lorebooks:deleteConfirm', { name: selectedBook?.name ?? '' })}
        confirmLabel={t('common:delete')}
        danger
        busy={deleteBook.isPending}
        onConfirm={() => void handleDeleteBook()}
      />
    </FloatingTabPanel>
  );
}

interface BooksTabProps {
  items: Lorebook[];
  totalLoaded: number;
  loading: boolean;
  isFetching: boolean;
  error: string | null;
  searchQuery: string;
  scope: BookScope;
  scopeCharacterId: string | null;
  hasNextPage: boolean;
  onSearchChange: (value: string) => void;
  onScopeChange: (scope: BookScope, characterId: string | null) => void;
  onSelect: (book: Lorebook) => void;
  onCreate: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

function BooksTab({
  items,
  totalLoaded,
  loading,
  isFetching,
  error,
  searchQuery,
  scope,
  scopeCharacterId,
  hasNextPage,
  onSearchChange,
  onScopeChange,
  onSelect,
  onCreate,
  onLoadMore,
  onRetry,
}: BooksTabProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.booksTab} data-part="lorebook-cards">
      <ActionBar
        collapse="compact"
        className={styles.cardToolbar}
        data-part="lorebook-card-toolbar"
      >
        <ActionBarGroup placement="primary">
          <Button variant="primary" startIcon={<Plus aria-hidden="true" />} onClick={onCreate}>
            {t('lorebooks:createShort')}
          </Button>
        </ActionBarGroup>
        <label className={styles.scopeControl}>
          <span className={styles.srOnly}>{t('lorebooks:filterLabel')}</span>
          <select
            value={scope}
            onChange={(event) => {
              const next = event.target.value as BookScope;
              onScopeChange(next, next === 'character' ? scopeCharacterId : null);
            }}
          >
            <option value="all">{t('lorebooks:filterAll')}</option>
            <option value="global">{t('lorebooks:filterGlobal')}</option>
            <option value="character">{t('lorebooks:filterCharacter')}</option>
          </select>
        </label>
      </ActionBar>

      {scope === 'character' ? (
        <CharacterPicker
          value={scopeCharacterId}
          onPick={(id) => onScopeChange('character', id)}
          emptyLabel={t('lorebooks:chooseCharacter')}
        />
      ) : null}

      <label className={styles.searchControl}>
        <MagnifyingGlass size={17} aria-hidden="true" />
        <span className={styles.srOnly}>{t('lorebooks:searchPlaceholder')}</span>
        <input
          type="search"
          placeholder={t('lorebooks:searchPlaceholder')}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>

      <div className={styles.listMeta}>
        <span>{t('lorebooks:loadedCount', { count: totalLoaded })}</span>
      </div>

      {loading ? (
        <p className={styles.hint}>{t('common:loading')}</p>
      ) : error ? (
        <div className={styles.emptyState}>
          <strong>{t('lorebooks:loadErrorTitle')}</strong>
          <p>{error}</p>
          <Button size="sm" onClick={onRetry}>
            {t('common:retry')}
          </Button>
        </div>
      ) : scope === 'character' && scopeCharacterId === null ? (
        <div className={styles.emptyState}>
          <BookOpenText size={32} aria-hidden="true" />
          <strong>{t('lorebooks:chooseCharacter')}</strong>
          <p>{t('lorebooks:emptyScopeHint')}</p>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <BookOpenText size={32} aria-hidden="true" />
          <strong>{searchQuery ? t('lorebooks:noResultsTitle') : t('lorebooks:emptyTitle')}</strong>
          <p>{searchQuery ? t('lorebooks:noResultsDescription') : t('lorebooks:emptyHint')}</p>
        </div>
      ) : (
        <div className={styles.bookList}>
          {items.map((book) => (
            <button
              key={book.id}
              type="button"
              className={styles.bookCard}
              onClick={() => onSelect(book)}
            >
              <span className={styles.cardIcon} aria-hidden="true">
                <BookOpenText size={18} />
              </span>
              <span className={styles.cardCopy}>
                <strong>{book.name}</strong>
                <span>{book.description.trim() || t('lorebooks:noDescription')}</span>
                <span className={styles.badges}>
                  {book.characterId === null ? (
                    <Badge tone="default">{t('lorebooks:globalBadge')}</Badge>
                  ) : (
                    <Badge tone="default">
                      <LinkedCharacterName characterId={book.characterId} />
                    </Badge>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {hasNextPage ? (
        <Button size="sm" onClick={onLoadMore} disabled={isFetching} className={styles.loadMore}>
          {isFetching ? t('common:loading') : t('common:loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function LinkedCharacterName({ characterId }: { characterId: string }) {
  const { t } = useTranslation();
  const character = useCharacter(characterId);
  return <>{t('lorebooks:characterBadge', { name: character.data?.name ?? '…' })}</>;
}

interface BookTabProps {
  book: Lorebook;
  busy: boolean;
  onNameSave: (name: string) => void;
  onDescriptionSave: (description: string) => void;
  onCharacterChange: (characterId: string | null) => void;
  onDelete: () => void;
  onBack: () => void;
  onOpenEntries: () => void;
}

function BookTab({
  book,
  busy,
  onNameSave,
  onDescriptionSave,
  onCharacterChange,
  onDelete,
  onBack,
  onOpenEntries,
}: BookTabProps) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = useState(book.name);
  const [descriptionDraft, setDescriptionDraft] = useState(book.description);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNameDraft(book.name);
    setDescriptionDraft(book.description);
  }, [book.id]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const scheduleDescriptionSave = (value: string): void => {
    setDescriptionDraft(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => onDescriptionSave(value), DESCRIPTION_SAVE_MS);
  };

  return (
    <div className={styles.bookTab} data-part="lorebook-editor">
      <div className={styles.editorActionBar}>
        <Button size="sm" onClick={onBack}>
          {t('lorebooks:backToBooks')}
        </Button>
        <div className={styles.primaryActions}>
          <Button size="sm" onClick={onOpenEntries} disabled={busy}>
            {t('lorebooks:entrySection')}
          </Button>
          <Button size="sm" onClick={onDelete} disabled={busy}>
            <Trash aria-hidden="true" />
            {t('common:delete')}
          </Button>
        </div>
      </div>

      <label className={styles.editorField}>
        <span>{t('lorebooks:nameLabel')}</span>
        <input
          type="text"
          value={nameDraft}
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => {
            const name = nameDraft.trim();
            if (name.length > 0 && name !== book.name) onNameSave(name);
          }}
        />
      </label>

      <div className={styles.editorField}>
        <div className={styles.fieldHeader}>
          <span>{t('lorebooks:description')}</span>
          <span className={styles.tokenCount}>
            {t('lorebooks:tokenEstimate', {
              count: descriptionDraft.length > 0 ? estimateTokens(descriptionDraft) : 0,
            })}
          </span>
        </div>
        <textarea
          value={descriptionDraft}
          placeholder={t('lorebooks:descriptionPlaceholder')}
          onChange={(event) => scheduleDescriptionSave(event.target.value)}
        />
      </div>

      <div className={styles.editorField}>
        <span>{t('lorebooks:linkedCharacter')}</span>
        <CharacterPicker value={book.characterId} onPick={onCharacterChange} />
        <p className={styles.hint}>{t('lorebooks:characterPickerHint')}</p>
      </div>
    </div>
  );
}

interface EntriesTabProps {
  book: Lorebook;
  entries: LorebookEntry[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}

function EntriesTab({ book, entries, loading, error, onRetry, onBack }: EntriesTabProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [entryDialog, setEntryDialog] = useState<{ entry: LorebookEntry | null } | null>(null);
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const createEntry = useCreateLorebookEntry();
  const updateEntry = useUpdateLorebookEntry();
  const deleteEntry = useDeleteLorebookEntry();

  const handleSave = async (input: LorebookEntryInput): Promise<void> => {
    setPanelError(null);
    try {
      if (entryDialog?.entry) {
        await updateEntry.mutateAsync({
          bookId: book.id,
          entryId: entryDialog.entry.id,
          update: input,
        });
      } else {
        await createEntry.mutateAsync({ bookId: book.id, input });
      }
      setEntryDialog(null);
    } catch (err) {
      setPanelError(errorText(err));
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleteEntryId) return;
    setPanelError(null);
    try {
      await deleteEntry.mutateAsync({ bookId: book.id, entryId: deleteEntryId });
      setDeleteEntryId(null);
    } catch (err) {
      setPanelError(errorText(err));
    }
  };

  return (
    <div className={styles.entriesTab} data-part="lorebook-entries">
      <div className={styles.editorActionBar}>
        <Button size="sm" onClick={onBack}>
          {t('lorebooks:backToBooks')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          startIcon={<Plus aria-hidden="true" />}
          onClick={() => setEntryDialog({ entry: null })}
        >
          {t('lorebooks:addEntry')}
        </Button>
      </div>

      <p className={styles.hint}>{t('lorebooks:entrySectionHint')}</p>

      {loading ? (
        <p className={styles.hint}>{t('common:loading')}</p>
      ) : error ? (
        <div className={styles.emptyState}>
          <strong>{t('lorebooks:loadErrorTitle')}</strong>
          <p>{error}</p>
          <Button size="sm" onClick={onRetry}>
            {t('common:retry')}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <div className={styles.emptyState}>
          <BookOpenText size={32} aria-hidden="true" />
          <strong>{t('lorebooks:noEntriesTitle')}</strong>
          <p>{t('lorebooks:noEntriesHint')}</p>
        </div>
      ) : (
        <div className={styles.entryList}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onToggle={(enabled) =>
                void updateEntry.mutateAsync({
                  bookId: book.id,
                  entryId: entry.id,
                  update: { enabled },
                })
              }
              onEdit={() => setEntryDialog({ entry })}
              onDelete={() => setDeleteEntryId(entry.id)}
            />
          ))}
        </div>
      )}

      {panelError ? (
        <p className={styles.error} role="alert">
          {panelError}
        </p>
      ) : null}

      {entryDialog ? (
        <EntryDialog
          book={book}
          entry={entryDialog.entry}
          busy={createEntry.isPending || updateEntry.isPending}
          onSave={(input) => void handleSave(input)}
          onClose={() => setEntryDialog(null)}
        />
      ) : null}

      <ConfirmActionDialog
        open={deleteEntryId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteEntryId(null);
        }}
        title={t('lorebooks:deleteEntryTitle')}
        description={t('lorebooks:deleteEntryConfirm', { name: book.name })}
        confirmLabel={t('common:delete')}
        danger
        busy={deleteEntry.isPending}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

interface EntryRowProps {
  entry: LorebookEntry;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function EntryRow({ entry, onToggle, onEdit, onDelete }: EntryRowProps) {
  const { t } = useTranslation();
  const headline =
    entry.keys[0] ?? (entry.constant ? t('lorebooks:entryConstant') : t('lorebooks:noDescription'));
  const snippet = entry.content.trim().slice(0, 120);
  return (
    <div className={styles.entryRow} data-state={entry.enabled ? 'enabled' : 'disabled'}>
      <div className={styles.entryMain}>
        <strong>{headline}</strong>
        <span>{snippet || t('lorebooks:noDescription')}</span>
        {entry.constant || entry.selective ? (
          <span className={styles.badges}>
            {entry.constant ? <Badge tone="default">{t('lorebooks:entryConstant')}</Badge> : null}
            {entry.selective ? <Badge tone="default">{t('lorebooks:entrySelective')}</Badge> : null}
          </span>
        ) : null}
      </div>
      <div className={styles.entryActions}>
        <Switch
          checked={entry.enabled}
          onCheckedChange={(checked) => onToggle(checked === true)}
          aria-label={t('lorebooks:entryEnabled')}
        />
        <IconButton
          label={t('lorebooks:editEntry')}
          icon={<PencilSimple size={15} aria-hidden="true" />}
          onClick={onEdit}
        />
        <IconButton
          label={t('lorebooks:deleteEntryTitle')}
          icon={<Trash size={15} aria-hidden="true" />}
          onClick={onDelete}
          danger
        />
      </div>
    </div>
  );
}

interface IconButtonProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

function IconButton({ label, icon, onClick, danger }: IconButtonProps) {
  return (
    <button
      type="button"
      className={danger ? styles.iconButtonDanger : styles.iconButton}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}

interface CharacterPickerProps {
  value: string | null;
  onPick: (characterId: string | null) => void;
  emptyLabel?: string;
}

function CharacterPicker({ value, onPick, emptyLabel }: CharacterPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(term), PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  const characters = useCharacters(
    debouncedTerm.trim()
      ? { q: debouncedTerm.trim(), limit: 20, sort: 'name' }
      : { limit: 20, sort: 'name' },
  );
  const matches = characters.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        type="button"
        className={styles.pickerTrigger}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={styles.pickerValue}>
          {value === null ? (
            (emptyLabel ?? t('lorebooks:linkedCharacterNone'))
          ) : (
            <LinkedCharacterName characterId={value} />
          )}
        </span>
        <span className={styles.pickerChevron} aria-hidden="true">
          {open ? <X size={14} /> : <MagnifyingGlass size={14} />}
        </span>
      </button>
      {open ? (
        <div
          className={styles.pickerMenu}
          role="listbox"
          aria-label={t('lorebooks:chooseCharacter')}
        >
          <label className={styles.pickerSearch}>
            <span className={styles.srOnly}>{t('lorebooks:characterPickerSearch')}</span>
            <input
              type="search"
              autoFocus
              placeholder={t('lorebooks:characterPickerSearch')}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
            />
          </label>
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            className={styles.pickerOption}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            {t('lorebooks:linkedCharacterNone')}
          </button>
          {matches.map((character) => (
            <button
              key={character.id}
              type="button"
              role="option"
              aria-selected={character.id === value}
              className={styles.pickerOption}
              onClick={() => {
                onPick(character.id);
                setOpen(false);
              }}
            >
              {character.id === value ? <Check size={14} aria-hidden="true" /> : null}
              <span>{character.name}</span>
            </button>
          ))}
          {matches.length === 0 ? (
            <p className={styles.pickerEmpty}>{t('lorebooks:noResultsDescription')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface LorebookEntryInput {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  enabled?: boolean;
  position?: number;
  constant?: boolean;
  selective?: boolean;
}

interface EntryDialogProps {
  book: Lorebook;
  entry: LorebookEntry | null;
  busy: boolean;
  onSave: (input: LorebookEntryInput) => void;
  onClose: () => void;
}

function EntryDialog({ book, entry, busy, onSave, onClose }: EntryDialogProps) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState(entry?.keys.join('\n') ?? '');
  const [secondaryKeys, setSecondaryKeys] = useState(entry?.secondaryKeys.join('\n') ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [constant, setConstant] = useState(entry?.constant ?? false);
  const [selective, setSelective] = useState(entry?.selective ?? false);
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [position, setPosition] = useState(entry?.position ?? 0);
  const [keysError, setKeysError] = useState<string | null>(null);

  const splitKeys = (value: string): string[] =>
    value
      .split(/\r?\n/)
      .map((key) => key.trim())
      .filter((key) => key.length > 0);

  const handleSave = (): void => {
    const parsedKeys = splitKeys(keys);
    if (parsedKeys.length === 0) {
      setKeysError(t('lorebooks:minKeysTitle'));
      return;
    }
    onSave({
      keys: parsedKeys,
      secondaryKeys: splitKeys(secondaryKeys),
      content: content.trim(),
      enabled,
      constant,
      selective,
      position,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={entry ? t('lorebooks:editEntry') : t('lorebooks:addEntry')}
        description={book.name}
      >
        <label className={styles.dialogField}>
          <span>{t('lorebooks:entryKeys')}</span>
          <textarea
            value={keys}
            onChange={(event) => {
              setKeys(event.target.value);
              setKeysError(null);
            }}
            className={keysError ? styles.fieldInvalid : undefined}
          />
        </label>
        {keysError ? (
          <p className={styles.fieldError} role="alert">
            {keysError}
          </p>
        ) : (
          <p className={styles.hint}>{t('lorebooks:entryKeysHint')}</p>
        )}

        <label className={styles.dialogField}>
          <span>{t('lorebooks:entrySecondaryKeys')}</span>
          <textarea
            value={secondaryKeys}
            onChange={(event) => setSecondaryKeys(event.target.value)}
          />
        </label>

        <label className={styles.dialogField}>
          <div className={styles.fieldHeader}>
            <span>{t('lorebooks:entryContent')}</span>
            <span className={styles.tokenCount}>
              {t('lorebooks:tokenEstimate', {
                count: content.length > 0 ? estimateTokens(content) : 0,
              })}
            </span>
          </div>
          <textarea
            value={content}
            placeholder={t('lorebooks:entryContentPlaceholder')}
            onChange={(event) => setContent(event.target.value)}
            className={styles.contentField}
          />
        </label>

        <div className={styles.dialogGrid}>
          <label className={styles.dialogField}>
            <span>{t('lorebooks:entryPosition')}</span>
            <input
              type="number"
              min={-1_000_000}
              max={1_000_000}
              value={position}
              onChange={(event) => setPosition(Number(event.target.value) || 0)}
            />
          </label>
          <label className={styles.checkboxRow}>
            <Switch
              checked={constant}
              onCheckedChange={(checked) => setConstant(checked === true)}
            />
            <span>{t('lorebooks:entryConstant')}</span>
          </label>
        </div>
        <p className={styles.hint}>{t('lorebooks:entryConstantHint')}</p>

        <label className={styles.checkboxRow}>
          <Switch
            checked={selective}
            onCheckedChange={(checked) => setSelective(checked === true)}
          />
          <span>{t('lorebooks:entrySelective')}</span>
        </label>

        <label className={styles.checkboxRow}>
          <Switch checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
          <span>{t('lorebooks:entryEnabled')}</span>
        </label>

        <div className={styles.dialogActions}>
          <DialogClose asChild>
            <Button disabled={busy}>{t('common:cancel')}</Button>
          </DialogClose>
          <Button disabled={busy} onClick={handleSave}>
            {t('common:save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
