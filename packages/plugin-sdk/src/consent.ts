/**
 * Install consent summary (ADR-0066 D1/D5).
 *
 * Before a package is installed, the user is shown what it will be allowed to do. This
 * module turns a manifest into that list — every risky capability, in plain terms, with
 * the risk grade the dialog uses to order and colour them.
 *
 * It is deliberately a pure function: the dialog renders what this returns, so the
 * wording and the ordering cannot drift between the web client and any future shell.
 */
import type { PluginManifest } from './manifest.js';

/** How much the user should think before granting. */
export type ConsentRisk = 'critical' | 'high' | 'medium' | 'low';

export interface ConsentItem {
  /** Capability as declared, so the dialog can group duplicates. */
  capability: string;
  /** i18n key (inside the `plugins` namespace) for the human label. */
  labelKey: string;
  risk: ConsentRisk;
  /** Why it matters, in one sentence the user can act on. */
  rationaleKey: string;
}

/**
 * Capabilities that deserve their own line in the dialog, ordered by risk.
 *
 * Anything not listed here is still granted (or not) exactly as declared; this list is
 * about *explaining*, not about permitting — the kernel is what permits.
 */
const EXPLAINED: Record<string, { labelKey: string; risk: ConsentRisk; rationaleKey: string }> = {
  'native.process': {
    labelKey: 'consentNativeProcess',
    risk: 'critical',
    rationaleKey: 'consentNativeProcessWhy',
  },
  'native.gpu': {
    labelKey: 'consentNativeGpu',
    risk: 'high',
    rationaleKey: 'consentNativeGpuWhy',
  },
  'ui.shell.replace': {
    labelKey: 'consentShellReplace',
    risk: 'high',
    rationaleKey: 'consentShellReplaceWhy',
  },
  'camera.request': {
    labelKey: 'consentCamera',
    risk: 'high',
    rationaleKey: 'consentCameraWhy',
  },
  'microphone.request': {
    labelKey: 'consentMicrophone',
    risk: 'high',
    rationaleKey: 'consentMicrophoneWhy',
  },
  'files.pick': {
    labelKey: 'consentFilesPick',
    risk: 'medium',
    rationaleKey: 'consentFilesPickWhy',
  },
  'files.save': {
    labelKey: 'consentFilesSave',
    risk: 'medium',
    rationaleKey: 'consentFilesSaveWhy',
  },
  'network.domains': {
    labelKey: 'consentNetwork',
    risk: 'medium',
    rationaleKey: 'consentNetworkWhy',
  },
  'secrets.use': {
    labelKey: 'consentSecrets',
    risk: 'medium',
    rationaleKey: 'consentSecretsWhy',
  },
  'clipboard.read': {
    labelKey: 'consentClipboardRead',
    risk: 'low',
    rationaleKey: 'consentClipboardReadWhy',
  },
};

const RISK_ORDER: Record<ConsentRisk, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Capability names from either the string or the scoped-object declaration form. */
function declaredCapabilities(manifest: PluginManifest): string[] {
  const names: string[] = [];
  for (const request of manifest.requiredCapabilities ?? []) {
    names.push(typeof request === 'string' ? request : request.name);
  }
  for (const permission of manifest.permissions ?? []) names.push(permission);
  return [...new Set(names)];
}

/**
 * Builds the consent list for a manifest, most dangerous first.
 *
 * Declared capabilities the host does not explain are omitted here on purpose: the
 * dialog would only repeat the technical name, and a wall of jargon trains users to
 * click through. The capability list itself is still visible in the install details.
 */
export function describeConsent(manifest: PluginManifest): ConsentItem[] {
  const items: ConsentItem[] = [];
  for (const capability of declaredCapabilities(manifest)) {
    const explained = EXPLAINED[capability];
    if (!explained) continue;
    items.push({ capability, ...explained });
  }
  return items.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);
}

/** True when the package asks for something the dialog must show prominently. */
export function requiresExplicitConsent(manifest: PluginManifest): boolean {
  return describeConsent(manifest).some((item) => item.risk === 'critical' || item.risk === 'high');
}
