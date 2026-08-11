import { memo, useMemo } from 'react';
import { cx } from '@neotavern/ui';
import { renderChatMarkdown } from '../lib/markdown.js';
import pluginStyles from './PluginMessageRenderers.module.css';
import styles from './MessageMarkdown.module.css';

export const MessageMarkdown = memo(MessageMarkdownInner);

function MessageMarkdownInner({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  // Parse once per (text, streaming) pair: markdown parsing is the dominant
  // per-bubble cost and must not repeat on every streaming flush of other
  // messages (OTHER-60).
  const html = useMemo(() => (text.length === 0 ? '' : renderChatMarkdown(text)), [text]);

  if (text.length === 0) {
    return streaming ? <span className={pluginStyles.typing}>...</span> : null;
  }

  return (
    <div
      className={cx(styles.root, className)}
      data-component="message-markdown"
      data-state={streaming ? 'streaming' : 'done'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
