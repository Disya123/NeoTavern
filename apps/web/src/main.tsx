/**
 * Frontend entry. Bootstraps i18n, applies the persisted theme/language,
 * installs legacy compatibility globals, then mounts the React tree.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { TooltipProvider } from '@neotavern/ui';
import { createI18n } from '@neotavern/i18n';
import { installLegacyCompat } from '@neotavern/legacy-compat/globals';
import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/opendyslexic/latin.css';
import '@neotavern/ui';
import './styles/preferences.css';
import { App } from './App.js';
import { connectAppEvents } from './api/events.js';
import { useUiStore } from './state/ui.js';
import { setInterfacePreferences, setThemeMode } from './theme/apply.js';
import { setDocumentLanguage } from './lib/lang.js';
import { registerServiceWorker } from './registerServiceWorker.js';
import { frontendPluginRuntime } from './plugins/runtime.js';
import { legacyFrontendRuntime } from './plugins/legacyRuntime.js';
import { watchAndroidSafeArea } from './lib/androidSafeArea.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function bootstrap(): Promise<void> {
  const {
    language,
    themeMode,
    density,
    scale,
    contrast,
    fontProfile,
    motion,
    chatStyle,
    chatAvatarStyle,
    userMessagePosition,
    characterMessagePosition,
  } = useUiStore.getState();

  setDocumentLanguage(language);
  setThemeMode(themeMode);
  setInterfacePreferences({
    density,
    scale,
    contrast,
    fontProfile,
    motion,
    chatStyle,
    chatAvatarStyle,
    userMessagePosition,
    characterMessagePosition,
  });
  watchAndroidSafeArea();

  // Documented legacy window globals for existing extensions.
  installLegacyCompat();

  const i18n = await createI18n({ language });
  frontendPluginRuntime.configureI18n(i18n);
  legacyFrontendRuntime.configureI18n(i18n);

  // Backend-driven changes (other tabs, legacy bridge, plugins) invalidate
  // the query caches through the SSE event channel (ТЗ §11.1).
  connectAppEvents(queryClient);

  const container = document.getElementById('root');
  if (!container) throw new Error('Root element #root not found');

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </I18nextProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
registerServiceWorker();
