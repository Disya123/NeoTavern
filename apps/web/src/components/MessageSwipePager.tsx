import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import styles from './MessageSwipePager.module.css';

export function MessageSwipePager({
  current,
  total,
  disabled = false,
  onPrevious,
  onNext,
}: {
  current: number;
  total: number;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  if (total <= 1) return null;

  return (
    <div className={styles.pager} data-component="message-swipe-pager" data-part="message-swipes">
      <button
        type="button"
        className={styles.button}
        data-action="swipe-previous"
        onClick={onPrevious}
        disabled={disabled || current <= 1}
        aria-label={t('chat:swipePrevious')}
        title={t('chat:swipePrevious')}
      >
        <CaretLeft weight="bold" aria-hidden="true" />
      </button>
      <span className={styles.counter} aria-live="polite">
        {t('chat:swipeCounter', { current, total })}
      </span>
      <button
        type="button"
        className={styles.button}
        data-action="swipe-next"
        onClick={onNext}
        disabled={disabled || current >= total}
        aria-label={t('chat:swipeNext')}
        title={t('chat:swipeNext')}
      >
        <CaretRight weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
