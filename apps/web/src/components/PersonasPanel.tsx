import {
  ChatsCircle,
  Copy,
  Crown,
  Lock,
  MagnifyingGlass,
  Plus,
  Smiley,
  Trash,
  User,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import type { Persona } from '@neotavern/contracts';
import { estimateTokens } from '@neotavern/shared';
import {
  ActionBar,
  ActionBarGroup,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Switch,
  Tabs,
  TextField,
} from '@neotavern/ui';
import {
  useChat,
  useCreatePersona,
  useDeletePersona,
  usePersonas,
  useSettings,
  useUpdateChat,
  useUpdatePersona,
  useUpdateSettings,
} from '../api/hooks.js';
import { useErrorText } from '../lib/useErrorText.js';
import {
  mergePersonasUiUpdate,
  readPersonasUi,
  type PersonaPlacementId,
} from '../lib/personasUi.js';
import { ConfirmActionDialog } from './ConfirmActionDialog.js';
import { FloatingTabContent } from './FloatingTabContent.js';
import { FloatingTabPanel } from './FloatingTabPanel.js';
import styles from './PersonasPanel.module.css';

const DESCRIPTION_SAVE_MS = 600;
const PERSONA_TABS = ['cards', 'edit'] as const;
type PersonaTab = (typeof PERSONA_TABS)[number];

interface PersonasPanelProps {
  onClose: () => void;
}

function readChatId(pathname: string): string | null {
  const match = /^\/chats\/([^/]+)$/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function PersonasPanel({ onClose }: PersonasPanelProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const errorText = useErrorText();
  const personas = usePersonas();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const deletePersona = useDeletePersona();
  const updateChat = useUpdateChat();

  const chatId = readChatId(location.pathname);
  const chat = useChat(chatId ?? undefined);

  const items = personas.data?.items ?? [];
  const activePersonaId = settings.data?.activePersonaId ?? null;
  const personasUi = readPersonasUi(settings.data);

  const [activeTab, setActiveTab] = useState<PersonaTab>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentPersona = items.find((persona) => persona.id === selectedId) ?? null;
  const canEdit = selectedId !== null;

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const filteredPersonas = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const filtered = query
      ? items.filter((persona) => persona.name.toLocaleLowerCase().includes(query))
      : items;
    return filtered.slice().sort((left, right) => {
      const cmp = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [items, searchQuery, sortOrder]);

  const busy =
    createPersona.isPending ||
    updatePersona.isPending ||
    deletePersona.isPending ||
    updateSettings.isPending ||
    updateChat.isPending;

  const selectPersona = (id: string, seed?: Pick<Persona, 'name' | 'description'>): void => {
    const persona = seed ?? items.find((item) => item.id === id);
    setSelectedId(id);
    setNameDraft(persona?.name ?? '');
    setDescriptionDraft(persona?.description ?? '');
    setPanelError(null);
    setActiveTab('edit');
  };

  const scheduleDescriptionSave = (personaId: string, description: string): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void updatePersona
        .mutateAsync({ id: personaId, update: { description } })
        .catch((error) => setPanelError(errorText(error)));
    }, DESCRIPTION_SAVE_MS);
  };

  const patchPersonasUi = async (
    patch: Parameters<typeof mergePersonasUiUpdate>[1],
  ): Promise<void> => {
    setPanelError(null);
    try {
      await updateSettings.mutateAsync(mergePersonasUiUpdate(settings.data, patch));
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const handleCreate = async (): Promise<void> => {
    const name = createName.trim() || t('personas:defaultName');
    setPanelError(null);
    try {
      const created = await createPersona.mutateAsync({ name });
      selectPersona(created.id, created);
      if (!activePersonaId) {
        await updateSettings.mutateAsync({ activePersonaId: created.id });
      }
      setCreateOpen(false);
      setCreateName('');
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const saveName = async (): Promise<void> => {
    if (!currentPersona) return;
    const name = nameDraft.trim();
    if (name.length === 0 || name === currentPersona.name) return;
    setPanelError(null);
    try {
      await updatePersona.mutateAsync({ id: currentPersona.id, update: { name } });
    } catch (error) {
      setPanelError(errorText(error));
      setNameDraft(currentPersona.name);
    }
  };

  const handleDuplicate = async (): Promise<void> => {
    if (!currentPersona) return;
    setPanelError(null);
    try {
      const created = await createPersona.mutateAsync({
        name: t('personas:duplicateCopy', { name: currentPersona.name }),
        description: currentPersona.description,
      });
      selectPersona(created.id, created);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!currentPersona) return;
    if (items.length <= 1) {
      setPanelError(t('personas:cannotDeleteLast'));
      setDeleteOpen(false);
      return;
    }
    setPanelError(null);
    try {
      await deletePersona.mutateAsync(currentPersona.id);
      if (activePersonaId === currentPersona.id) {
        const fallback = items.find((persona) => persona.id !== currentPersona.id);
        await updateSettings.mutateAsync({ activePersonaId: fallback?.id ?? null });
      }
      setSelectedId(null);
      setActiveTab('cards');
      setDeleteOpen(false);
    } catch (error) {
      setPanelError(errorText(error));
    }
  };

  return (
    <FloatingTabPanel
      component="personas-panel"
      headerPart="personas-header"
      avatar={
        <span className={styles.headerAvatar} aria-hidden="true">
          {currentPersona ? currentPersona.name.slice(0, 1).toUpperCase() : <Smiley size={20} />}
        </span>
      }
      title={t('personas:managementTitle')}
      onClose={onClose}
    >
      <Tabs
        variant="segment"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PersonaTab)}
        className={styles.tabs}
        contentClassName={styles.tabPanel}
        scrollable
        scrollMode="root"
        ariaLabel={t('personas:managementTabs')}
        tabs={PERSONA_TABS.map((tab) => ({
          value: tab,
          label: t(`personas:tab_${tab}`),
          disabled: tab === 'edit' && !canEdit,
          content: (
            <FloatingTabContent>
              {tab === 'cards' ? (
                <CardsTab
                  items={filteredPersonas}
                  allItems={items}
                  selectedId={selectedId}
                  activePersonaId={activePersonaId}
                  searchQuery={searchQuery}
                  sortOrder={sortOrder}
                  loading={personas.isLoading}
                  error={personas.isError ? errorText(personas.error) : null}
                  onSearchChange={setSearchQuery}
                  onSortChange={setSortOrder}
                  onSelect={selectPersona}
                  onCreate={() => {
                    setCreateName('');
                    setCreateOpen(true);
                  }}
                  onRetry={() => void personas.refetch()}
                />
              ) : currentPersona ? (
                <EditTab
                  persona={currentPersona}
                  nameDraft={nameDraft}
                  descriptionDraft={descriptionDraft}
                  placement={personasUi.placement ?? 'persona'}
                  personasUi={personasUi}
                  chatId={chatId}
                  chatPersonaId={chat.data?.personaId ?? null}
                  activePersonaId={activePersonaId}
                  busy={busy}
                  onNameChange={setNameDraft}
                  onNameBlur={() => void saveName()}
                  onDescriptionChange={(value) => {
                    setDescriptionDraft(value);
                    scheduleDescriptionSave(currentPersona.id, value);
                  }}
                  onPlacementChange={(next) => void patchPersonasUi({ placement: next })}
                  onConnectDefault={async () => {
                    setPanelError(null);
                    try {
                      await updateSettings.mutateAsync({ activePersonaId: currentPersona.id });
                      if (!currentPersona.isDefault) {
                        await updatePersona.mutateAsync({
                          id: currentPersona.id,
                          update: { isDefault: true },
                        });
                      }
                    } catch (error) {
                      setPanelError(errorText(error));
                    }
                  }}
                  onConnectChat={async () => {
                    if (!chatId) return;
                    setPanelError(null);
                    try {
                      await updateChat.mutateAsync({
                        id: chatId,
                        update: { personaId: currentPersona.id },
                      });
                      if (personasUi.autoLockToChat) {
                        await updateSettings.mutateAsync({ activePersonaId: currentPersona.id });
                      }
                    } catch (error) {
                      setPanelError(errorText(error));
                    }
                  }}
                  onPatchPersonasUi={patchPersonasUi}
                  onDuplicate={() => void handleDuplicate()}
                  onDelete={() => setDeleteOpen(true)}
                  onBack={() => setActiveTab('cards')}
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
        <DialogContent title={t('personas:createTitle')} description={t('personas:createHint')}>
          <TextField
            label={t('personas:nameLabel')}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder={t('personas:defaultName')}
            autoFocus
          />
          <div className={styles.dialogActions}>
            <DialogClose asChild>
              <Button disabled={busy}>{t('common:cancel')}</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void handleCreate()}>
              {t('common:create')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('personas:deleteTitle')}
        description={t('personas:deleteConfirm', { name: currentPersona?.name ?? '' })}
        confirmLabel={t('common:delete')}
        danger
        busy={busy}
        onConfirm={() => void handleDelete()}
      />
    </FloatingTabPanel>
  );
}

interface CardsTabProps {
  items: Persona[];
  allItems: Persona[];
  selectedId: string | null;
  activePersonaId: string | null;
  searchQuery: string;
  sortOrder: 'asc' | 'desc';
  loading: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onSortChange: (value: 'asc' | 'desc') => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}

function CardsTab({
  items,
  allItems,
  selectedId,
  activePersonaId,
  searchQuery,
  sortOrder,
  loading,
  error,
  onSearchChange,
  onSortChange,
  onSelect,
  onCreate,
  onRetry,
}: CardsTabProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.cardsTab} data-part="persona-cards">
      <ActionBar collapse="compact" className={styles.cardToolbar} data-part="persona-card-toolbar">
        <ActionBarGroup placement="primary">
          <Button variant="primary" startIcon={<Plus aria-hidden="true" />} onClick={onCreate}>
            {t('personas:createShort')}
          </Button>
        </ActionBarGroup>
        <label className={styles.sortControl}>
          <span className={styles.srOnly}>{t('personas:sortLabel')}</span>
          <select
            value={sortOrder === 'asc' ? 'A-Z' : 'Z-A'}
            onChange={(event) => onSortChange(event.target.value === 'Z-A' ? 'desc' : 'asc')}
          >
            <option value="A-Z">{t('personas:sortAsc')}</option>
            <option value="Z-A">{t('personas:sortDesc')}</option>
          </select>
        </label>
      </ActionBar>

      <label className={styles.searchControl}>
        <MagnifyingGlass size={17} aria-hidden="true" />
        <span className={styles.srOnly}>{t('personas:searchPlaceholder')}</span>
        <input
          type="search"
          placeholder={t('personas:searchPlaceholder')}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>

      <div className={styles.listMeta}>
        <span>{t('personas:loadedCount', { count: allItems.length })}</span>
      </div>

      {loading ? (
        <p className={styles.hint}>{t('common:loading')}</p>
      ) : error ? (
        <div className={styles.emptyState}>
          <strong>{t('personas:loadErrorTitle')}</strong>
          <p>{error}</p>
          <Button size="sm" onClick={onRetry}>
            {t('common:retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>
          <Smiley size={32} aria-hidden="true" />
          <strong>{searchQuery ? t('personas:noResultsTitle') : t('personas:emptyTitle')}</strong>
          <p>{searchQuery ? t('personas:noResultsDescription') : t('personas:emptyHint')}</p>
        </div>
      ) : (
        <div className={styles.personaList}>
          {items.map((persona) => {
            const selected = persona.id === selectedId;
            const isActive = persona.id === activePersonaId;
            return (
              <button
                key={persona.id}
                type="button"
                className={styles.personaCard}
                data-state={selected ? 'selected' : 'idle'}
                onClick={() => onSelect(persona.id)}
                aria-pressed={selected}
              >
                <span className={styles.cardAvatar} aria-hidden="true">
                  {persona.name.slice(0, 1).toUpperCase()}
                </span>
                <span className={styles.cardCopy}>
                  <strong>{persona.name}</strong>
                  <span>{persona.description.trim() || t('personas:noDescription')}</span>
                  {isActive || persona.isDefault ? (
                    <span className={styles.badges}>
                      {isActive ? (
                        <span className={styles.badge}>{t('personas:activeBadge')}</span>
                      ) : null}
                      {persona.isDefault ? (
                        <span className={styles.badge}>{t('personas:defaultBadge')}</span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface EditTabProps {
  persona: Persona;
  nameDraft: string;
  descriptionDraft: string;
  placement: PersonaPlacementId;
  personasUi: ReturnType<typeof readPersonasUi>;
  chatId: string | null;
  chatPersonaId: string | null;
  activePersonaId: string | null;
  busy: boolean;
  onNameChange: (value: string) => void;
  onNameBlur: () => void;
  onDescriptionChange: (value: string) => void;
  onPlacementChange: (value: PersonaPlacementId) => void;
  onConnectDefault: () => Promise<void>;
  onConnectChat: () => Promise<void>;
  onPatchPersonasUi: (patch: Parameters<typeof mergePersonasUiUpdate>[1]) => Promise<void>;
  onDuplicate: () => void;
  onDelete: () => void;
  onBack: () => void;
}

function EditTab({
  persona,
  nameDraft,
  descriptionDraft,
  placement,
  personasUi,
  chatId,
  chatPersonaId,
  activePersonaId,
  busy,
  onNameChange,
  onNameBlur,
  onDescriptionChange,
  onPlacementChange,
  onConnectDefault,
  onConnectChat,
  onPatchPersonasUi,
  onDuplicate,
  onDelete,
  onBack,
}: EditTabProps) {
  const { t } = useTranslation();

  const connectionType =
    chatId && chatPersonaId === persona.id
      ? 'chat'
      : persona.isDefault || activePersonaId === persona.id
        ? 'default'
        : null;

  return (
    <div className={styles.editor} data-part="persona-editor">
      <div className={styles.editorActionBar}>
        <Button size="sm" onClick={onBack}>
          {t('personas:backToCards')}
        </Button>
        <div className={styles.primaryActions}>
          <Button size="sm" onClick={onDuplicate} disabled={busy}>
            <Copy aria-hidden="true" />
            {t('common:duplicate')}
          </Button>
          <Button size="sm" onClick={onDelete} disabled={busy}>
            <Trash aria-hidden="true" />
            {t('common:delete')}
          </Button>
        </div>
      </div>

      <label className={styles.editorField}>
        <span>{t('personas:nameLabel')}</span>
        <input
          type="text"
          value={nameDraft}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={onNameBlur}
        />
      </label>

      <div className={styles.editorField}>
        <div className={styles.fieldHeader}>
          <span>{t('personas:description')}</span>
          <span className={styles.tokenCount}>
            {t('personas:tokenEstimate', {
              count: descriptionDraft.length > 0 ? estimateTokens(descriptionDraft) : 0,
            })}
          </span>
        </div>
        <textarea
          value={descriptionDraft}
          placeholder={t('personas:descriptionPlaceholder')}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
      </div>

      <label className={styles.editorField}>
        <span>{t('personas:position')}</span>
        <select
          value={placement}
          disabled={busy}
          onChange={(event) => onPlacementChange(event.target.value as PersonaPlacementId)}
        >
          <option value="persona">{t('personas:positionPersona')}</option>
          <option value="authors-note-top">{t('personas:positionAuthorsNoteTop')}</option>
          <option value="authors-note-bottom">{t('personas:positionAuthorsNoteBottom')}</option>
          <option value="in-chat">{t('personas:positionInChat')}</option>
        </select>
      </label>

      <div className={styles.editorField}>
        <span className={styles.sectionLabel}>{t('personas:connections')}</span>
        <div className={styles.connections} role="group" aria-label={t('personas:connections')}>
          <button
            type="button"
            className={styles.connectionButton}
            data-state={connectionType === 'default' ? 'active' : 'inactive'}
            disabled={busy}
            onClick={() => void onConnectDefault()}
          >
            <Crown aria-hidden="true" />
            <span className={styles.connectionLabel}>{t('personas:connectionDefault')}</span>
          </button>
          <button
            type="button"
            className={styles.connectionButton}
            data-state="inactive"
            disabled
            title={t('personas:connectionCharacterHint')}
          >
            <User aria-hidden="true" />
            <span className={styles.connectionLabel}>{t('personas:connectionCharacter')}</span>
          </button>
          <button
            type="button"
            className={styles.connectionButton}
            data-state={connectionType === 'chat' ? 'active' : 'inactive'}
            disabled={busy || !chatId}
            title={chatId ? undefined : t('personas:connectionChatHint')}
            onClick={() => void onConnectChat()}
          >
            {chatId ? <ChatsCircle aria-hidden="true" /> : <Lock aria-hidden="true" />}
            <span className={styles.connectionLabel}>{t('personas:connectionChat')}</span>
          </button>
        </div>
        <p className={styles.hint}>
          {chatId ? t('personas:connectionsHintChat') : t('personas:connectionsHintDefault')}
        </p>
      </div>

      <div className={styles.globalSettings}>
        <span className={styles.sectionLabel}>{t('personas:globalSettings')}</span>
        <label className={styles.checkboxRow}>
          <Switch
            checked={personasUi.showSwitchNotifications ?? true}
            disabled={busy}
            onCheckedChange={(checked) =>
              void onPatchPersonasUi({ showSwitchNotifications: checked })
            }
          />
          <span>{t('personas:notifyOnSwitch')}</span>
        </label>
        <label className={styles.checkboxRow}>
          <Switch
            checked={personasUi.allowMultipleConnections ?? false}
            disabled={busy}
            onCheckedChange={(checked) =>
              void onPatchPersonasUi({ allowMultipleConnections: checked })
            }
          />
          <span>{t('personas:allowMultipleConnections')}</span>
        </label>
        <label className={styles.checkboxRow}>
          <Switch
            checked={personasUi.autoLockToChat ?? false}
            disabled={busy}
            onCheckedChange={(checked) => void onPatchPersonasUi({ autoLockToChat: checked })}
          />
          <span>{t('personas:autoLockToChat')}</span>
        </label>
      </div>
    </div>
  );
}
