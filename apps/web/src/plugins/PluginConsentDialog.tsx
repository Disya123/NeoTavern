/**
 * Install consent dialog (ADR-0066 P5b).
 *
 * Shows what a package will be allowed to do before it is installed, ordered by risk,
 * with the reason spelled out. The data comes from `describeConsent`, so the wording
 * and the ordering are shared with any other shell that installs plugins.
 *
 * The dialog never installs anything itself: it returns a decision and the caller
 * performs the install. That keeps the consent step impossible to skip by accident when
 * a new install path is added.
 */
import { useTranslation } from 'react-i18next';
import { describeConsent, type PluginManifest } from '@neotavern/plugin-sdk';

export interface PluginConsentDialogProps {
  manifest: PluginManifest;
  /** Called with `true` when the user accepts, `false` on cancel or dismiss. */
  onDecide: (accepted: boolean) => void;
}

export function PluginConsentDialog({ manifest, onDecide }: PluginConsentDialogProps) {
  const { t } = useTranslation();
  const items = describeConsent(manifest);

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={t('plugins:consentTitle')}
      data-part="plugin-consent"
    >
      <h3>{t('plugins:consentTitle')}</h3>
      <p data-part="plugin-consent-package">
        {manifest.name} {manifest.version}
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.capability} data-risk={item.risk} data-capability={item.capability}>
            <strong>{t(`plugins:${item.labelKey}`)}</strong>
            <p>{t(`plugins:${item.rationaleKey}`)}</p>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" onClick={() => onDecide(false)}>
          {t('plugins:consentCancel')}
        </button>
        <button type="button" onClick={() => onDecide(true)}>
          {t('plugins:consentAccept')}
        </button>
      </div>
    </section>
  );
}
