import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpenText,
  CaretDown,
  CaretUp,
  ChatCircleDots,
  ChatsCircle,
  GithubLogo,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, ErrorBoundary, Skeleton } from '@neotavern/ui';
import { SUPPORTED_LANGUAGES } from '@neotavern/i18n';
import {
  useAppVersion,
  useCharacter,
  useCharacters,
  useCreateChat,
  useProviders,
  useRecentChats,
  useSettings,
} from '../api/hooks.js';
import { clampSwipeIndex, collectCharacterGreetings } from '@neotavern/shared';
import { expandDisplayMacros, useMacroContext } from '../lib/macros.js';
import { useErrorText } from '../lib/useErrorText.js';
import { setDocumentLanguage } from '../lib/lang.js';
import { useConversationContextPreview } from '../lib/useConversationContextPreview.js';
import { useUiStore } from '../state/ui.js';
import { ChatComposer } from '../components/ChatComposer.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { ChatWorkspace } from '../components/ChatWorkspace.js';
import workspaceStyles from '../components/ChatWorkspace.module.css';
import { ContextUsagePanel } from '../components/ContextUsagePanel.js';
import { MessageBubble } from '../components/MessageBubble.js';
import { SystemSurfaceLink } from '../components/SystemSurfaceLink.js';
import styles from './HomePage.module.css';

export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const pinnedCharacterId = useUiStore((state) => state.pinnedCharacterId);
  const setPinnedCharacterId = useUiStore((state) => state.setPinnedCharacterId);
  const openSidebarPanel = useUiStore((state) => state.openSidebarPanel);
  const language = useUiStore((state) => state.language);
  const setLanguage = useUiStore((state) => state.setLanguage);
  const scale = useUiStore((state) => state.scale);
  const setScale = useUiStore((state) => state.setScale);
  const recentCharacters = useCharacters({ sort: 'newest', limit: 12 });
  const pinnedCharacter = useCharacter(pinnedCharacterId ?? undefined);
  const createChat = useCreateChat();
  const settings = useSettings();
  const providers = useProviders();
  const draft = useUiStore((state) => state.drafts.home ?? '');
  const setSessionDraft = useUiStore((state) => state.setDraft);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [greetingIndex, setGreetingIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const recent = recentCharacters.data?.pages.flatMap((page) => page.items) ?? [];
  const fallbackCharacter = recent[0];
  const fullCharacter = pinnedCharacter.data;
  const character =
    fullCharacter ?? recent.find((item) => item.id === pinnedCharacterId) ?? fallbackCharacter;
  const greetings =
    fullCharacter && fullCharacter.id === character?.id
      ? collectCharacterGreetings(fullCharacter)
      : [];
  const selectedGreetingIndex = clampSwipeIndex(greetingIndex, greetings.length);
  const greeting = greetings[selectedGreetingIndex] ?? '';
  const macroContext = useMacroContext({ charName: character?.name });
  const displayGreeting = greeting ? expandDisplayMacros(greeting, macroContext) : '';
  const activeProvider = providers.data?.items.find(
    (item) => item.id === settings.data?.activeProviderConfigId,
  );
  const providerReady = activeProvider !== undefined;
  const changeLanguage = async (value: string): Promise<void> => {
    setLanguage(value);
    setDocumentLanguage(value);
    await i18n.changeLanguage(value);
  };

  useEffect(() => {
    if ((!pinnedCharacterId || pinnedCharacter.isError) && fallbackCharacter) {
      setPinnedCharacterId(fallbackCharacter.id);
    }
  }, [fallbackCharacter, pinnedCharacter.isError, pinnedCharacterId, setPinnedCharacterId]);

  useEffect(() => {
    setGreetingIndex(0);
  }, [character?.id]);

  const {
    contextUsage,
    preview,
    isLoading: contextPreviewLoading,
    isError: contextPreviewError,
    triggerPending: contextTriggerPending,
  } = useConversationContextPreview({
    source: character
      ? {
          characterId: character.id,
          greeting,
          ...(settings.data?.activePersonaId ? { personaId: settings.data.activePersonaId } : {}),
        }
      : undefined,
    draft,
  });

  const startConversation = async (): Promise<void> => {
    const message = draft.trim();
    if (!character || message.length === 0 || createChat.isPending) return;

    setSubmitError(null);
    try {
      const chat = await createChat.mutateAsync({
        characterId: character.id,
        title: character.name,
        greetingIndex: selectedGreetingIndex,
        reuseUnstarted: true,
        ...(settings.data?.activePersonaId ? { personaId: settings.data.activePersonaId } : {}),
      });
      setSessionDraft('home', '');
      navigate(`/chats/${chat.id}`, {
        state: { initialMessage: message },
      });
    } catch (error) {
      setSubmitError(errorText(error));
    }
  };

  const clearDraft = (): void => {
    setSessionDraft('home', '');
    inputRef.current?.focus();
  };

  if (!character && recentCharacters.isError) {
    return (
      <ErrorBoundary name="home">
        <section className={styles.page} data-component="home">
          <div className={styles.wallpaper} data-part="chat-wallpaper" aria-hidden="true" />
          <section className={styles.noCharacter} role="alert">
            <div className={styles.emptyIcon} aria-hidden="true">
              <ChatCircleDots size={32} weight="duotone" />
            </div>
            <h1>{t('characters:errorTitle')}</h1>
            <p>{errorText(recentCharacters.error)}</p>
            <Button variant="primary" onClick={() => void recentCharacters.refetch()}>
              {t('common:retry')}
            </Button>
          </section>
        </section>
      </ErrorBoundary>
    );
  }

  if (!character && !recentCharacters.isLoading) {
    return (
      <ErrorBoundary name="home">
        <section className={styles.page} data-component="home">
          <div className={styles.wallpaper} data-part="chat-wallpaper" aria-hidden="true" />
          <section className={styles.noCharacter}>
            <div className={styles.onboardingIntro}>
              <div className={styles.emptyIcon} aria-hidden="true">
                <Sparkle size={32} weight="duotone" />
              </div>
              <div>
                <span>{t('home:getStartedEyebrow')}</span>
                <h1>{t('home:noCharacterTitle')}</h1>
                <p>{t('home:noCharacterDescription')}</p>
              </div>
            </div>
            <div className={styles.onboardingPreferences}>
              <label>
                <span>{t('settings:language')}</span>
                <select
                  data-component="input"
                  value={language}
                  onChange={(event) => void changeLanguage(event.target.value)}
                >
                  {SUPPORTED_LANGUAGES.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('settings:interfaceScale')}</span>
                <select
                  data-component="input"
                  value={scale}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === 'small' || value === 'medium' || value === 'large') {
                      setScale(value);
                    }
                  }}
                >
                  <option value="small">{t('settings:scaleSmall')}</option>
                  <option value="medium">{t('settings:scaleMedium')}</option>
                  <option value="large">{t('settings:scaleLarge')}</option>
                </select>
              </label>
            </div>
            <ol className={styles.onboardingSteps} aria-label={t('home:getStartedSteps')}>
              <li data-state={providerReady ? 'done' : 'active'}>
                <span aria-hidden="true">1</span>
                <div>
                  <strong>{t('home:setupProvider')}</strong>
                  <p>{providerReady ? t('home:setupProviderDone') : t('home:setupProviderHint')}</p>
                </div>
                <Button asChild variant={providerReady ? 'ghost' : 'default'} size="sm">
                  <SystemSurfaceLink to="/providers">
                    {providerReady ? t('home:reviewProvider') : t('home:setupProviderAction')}
                  </SystemSurfaceLink>
                </Button>
              </li>
              <li data-state="active">
                <span aria-hidden="true">2</span>
                <div>
                  <strong>{t('home:setupCharacter')}</strong>
                  <p>{t('home:setupCharacterHint')}</p>
                </div>
                <Button asChild variant="primary" size="sm">
                  <SystemSurfaceLink to="/characters">
                    {t('home:addCharacter')}
                    <ArrowRight aria-hidden="true" />
                  </SystemSurfaceLink>
                </Button>
              </li>
              <li data-state="pending">
                <span aria-hidden="true">3</span>
                <div>
                  <strong>{t('home:startChat')}</strong>
                  <p>{t('home:startChatHint')}</p>
                </div>
              </li>
            </ol>
          </section>
        </section>
      </ErrorBoundary>
    );
  }

  const globalBackgroundId = useUiStore((state) => state.globalBackgroundId);
  const wallpaperUrl = useMemo(() => {
    return globalBackgroundId
      ? // eslint-disable-next-line @neotavern/no-legacy-api-surface
        `/api/v2/assets/backgrounds/${encodeURIComponent(globalBackgroundId)}`
      : null;
  }, [globalBackgroundId]);

  return (
    <ErrorBoundary name="home">
      <ChatWorkspace
        viewName="home"
        wallpaperUrl={wallpaperUrl}
        viewportLabel={t('accessibility:messageList')}
        footerError={submitError ?? undefined}
        header={
          <ChatHeader
            name={character?.name ?? null}
            avatar={character?.avatar}
            searchableTexts={displayGreeting ? [displayGreeting] : []}
            onQueryChange={setChatSearchQuery}
          />
        }
        composer={
          <ChatComposer
            textareaId="home-message"
            value={draft}
            placeholder={t('home:composerPlaceholder', { name: character?.name })}
            inputRef={inputRef}
            onChange={(value) => setSessionDraft('home', value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void startConversation();
              }
            }}
            onOpenSettings={() => openSidebarPanel('providers')}
            onReset={clearDraft}
            contextPanelId="home-context-details"
            contextOpen={contextOpen}
            onToggleContext={() => setContextOpen((open) => !open)}
            contextTriggerTitle={
              contextTriggerPending
                ? t('common:loading')
                : `${t('chat:contextPromptTokens')}: ${contextUsage.promptTokens.toLocaleString()} / ${t('chat:contextLimit')}: ${contextUsage.contextLimit.toLocaleString()}`
            }
            contextTriggerLabel={contextTriggerPending ? '…' : `${contextUsage.usagePercent}%`}
            contextPanel={
              <ContextUsagePanel
                id="home-context-details"
                summary={contextUsage}
                source="preview"
                isLoading={contextPreviewLoading}
                isError={contextPreviewError}
                tokenizerProfile={preview?.tokenizer.profile}
                tokenizerApproximate={preview?.tokenizer.approximate}
              />
            }
            onSubmit={() => void startConversation()}
            submitDisabled={
              !character || !providerReady || draft.trim().length === 0 || createChat.isPending
            }
            submitPendingLabel={createChat.isPending ? t('home:openingChat') : undefined}
          />
        }
      >
        <RecentChatsStrip />
        {character && greeting ? (
          <div data-component="home-greeting-message">
            <MessageBubble
              message={{
                id: '__home_greeting__',
                chatId: '',
                branchId: '',
                parentId: null,
                role: 'assistant',
                content: greeting,
                name: character.name,
                meta: {
                  greeting: true,
                  swipes: greetings,
                  swipeId: selectedGreetingIndex,
                },
                createdAt: 0,
                revision: 1,
                updatedAt: null,
                variantCount: 0,
                activeVariantPosition: null,
                contentRevisionCount: 0,
                checkpointChatId: null,
              }}
              macroContext={macroContext}
              assistantIdentity={{
                name: character.name,
                avatar: character.avatar,
              }}
              searchQuery={chatSearchQuery}
              swipe={
                greetings.length > 1
                  ? {
                      current: selectedGreetingIndex + 1,
                      total: greetings.length,
                      onPrevious: () =>
                        setGreetingIndex((index) => clampSwipeIndex(index - 1, greetings.length)),
                      onNext: () =>
                        setGreetingIndex((index) => clampSwipeIndex(index + 1, greetings.length)),
                    }
                  : undefined
              }
            />
          </div>
        ) : (
          <div className={workspaceStyles.chatState} data-component="chat-state">
            <span className={workspaceStyles.chatStateIcon} aria-hidden="true">
              <ChatCircleDots size={32} weight="duotone" />
            </span>
            <h2>{t('chat:emptyChat')}</h2>
            <p>{t('home:emptyChatHint', { name: character?.name })}</p>
          </div>
        )}
      </ChatWorkspace>
    </ErrorBoundary>
  );
}

export function RecentChatsStrip() {
  const { t, i18n } = useTranslation();
  const appVersion = useAppVersion();
  const recentChats = useRecentChats(8);
  const items = recentChats.data?.items ?? [];
  const [recentVisible, setRecentVisible] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const visibleItems = items.slice(0, expanded ? 8 : 3);
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
  });

  return (
    <section className={styles.homeOverview} data-component="home-overview">
      <header className={styles.productHeader} data-part="product-header">
        <p className={styles.productBrand}>
          <strong>{t('home:appName')}</strong>
          <span>{appVersion.data?.version ?? t('home:versionLoading')}</span>
        </p>
        <div className={styles.productActions}>
          <nav className={styles.resourceLinks} aria-label={t('home:resourceLinks')}>
            <a href="https://docs.neotavern.com/" target="_blank" rel="noopener noreferrer">
              <BookOpenText aria-hidden="true" />
              <span>{t('home:docsLink')}</span>
            </a>
            <a
              href="https://github.com/Disya123/NeoTavern"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GithubLogo aria-hidden="true" />
              <span>{t('home:githubLink')}</span>
            </a>
          </nav>
          {!recentVisible ? (
            <Button
              className={styles.recentVisibilityButton}
              variant="ghost"
              size="sm"
              aria-controls="home-recent-chats"
              aria-expanded="false"
              aria-label={t('home:showRecentChats')}
              title={t('home:showRecentChats')}
              onClick={() => setRecentVisible(true)}
            >
              <CaretDown aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </header>

      {recentVisible ? (
        <div
          id="home-recent-chats"
          className={styles.recentChats}
          data-component="recent-chats"
          data-state={recentChats.isLoading ? 'loading' : recentChats.isError ? 'error' : 'ready'}
          aria-labelledby="home-recent-chats-title"
          aria-busy={recentChats.isLoading}
        >
          <header className={styles.recentHeader} data-part="header">
            <h2 id="home-recent-chats-title">{t('home:recentChatsTitle')}</h2>
            <Button
              className={styles.recentVisibilityButton}
              variant="ghost"
              size="sm"
              aria-controls="home-recent-chats"
              aria-expanded="true"
              aria-label={t('home:hideRecentChats')}
              title={t('home:hideRecentChats')}
              onClick={() => setRecentVisible(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          {recentChats.isLoading ? (
            <div className={styles.recentSkeletons} data-part="list">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className={styles.recentSkeleton} />
              ))}
            </div>
          ) : recentChats.isError ? (
            <div className={styles.recentStatus} data-part="error" role="alert">
              <span>{t('home:recentChatsError')}</span>
              <Button size="sm" onClick={() => void recentChats.refetch()}>
                {t('common:retry')}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className={styles.recentStatus} data-part="empty">
              {t('home:noRecentChats')}
            </p>
          ) : (
            <nav aria-label={t('home:recentChatsLabel')} data-part="list">
              <ul className={styles.recentList} id="home-recent-chats-list">
                {visibleItems.map((chat) => {
                  const characterName = chat.characterName?.trim() || t('chat:unnamedCharacter');
                  return (
                    <li key={chat.id} className={styles.recentItem} data-part="item">
                      <Link className={styles.recentLink} to={`/chats/${chat.id}`}>
                        {chat.characterAvatar ? (
                          <img
                            className={styles.recentAvatar}
                            data-part="avatar"
                            src={chat.characterAvatar}
                            alt=""
                          />
                        ) : (
                          <span
                            className={styles.recentAvatarFallback}
                            data-part="avatar"
                            aria-hidden="true"
                          >
                            {chat.characterName?.slice(0, 1).toLocaleUpperCase() ?? (
                              <ChatsCircle weight="duotone" />
                            )}
                          </span>
                        )}
                        <span className={styles.recentCopy} data-part="copy">
                          <span className={styles.recentTitle}>
                            <strong>{characterName}</strong>
                            <span aria-hidden="true">{' \u2014 '}</span>
                            <span>{chat.title}</span>
                          </span>
                          <span className={styles.recentMessages}>
                            {t('chat:messages', { count: chat.messageCount })}
                          </span>
                        </span>
                        <time
                          className={styles.recentDate}
                          dateTime={new Date(chat.updatedAt).toISOString()}
                        >
                          {dateFormatter.format(chat.updatedAt)}
                        </time>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {items.length > 3 ? (
                <div className={styles.recentToggle} data-part="toggle">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-controls="home-recent-chats-list"
                    aria-expanded={expanded}
                    aria-label={
                      expanded ? t('home:showFewerRecentChats') : t('home:showMoreRecentChats')
                    }
                    title={
                      expanded ? t('home:showFewerRecentChats') : t('home:showMoreRecentChats')
                    }
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? <CaretUp aria-hidden="true" /> : <CaretDown aria-hidden="true" />}
                  </Button>
                </div>
              ) : null}
            </nav>
          )}
        </div>
      ) : null}
    </section>
  );
}
