import { useEffect, useState } from 'react';
import type { Message } from '@neotavern/contracts';
import { frontendPluginRuntime, usePluginRegistrations } from '../plugins/runtime.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import styles from './PluginMessageRenderers.module.css';

interface RenderedMessage {
  registrationId: string;
  pluginName: string;
  text: string;
  placement: 'replace' | 'after';
}

export function PluginRenderedMessage({
  message,
  displayContent,
  className,
  streaming,
  highlightQuery,
}: {
  message: Message;
  /** Expanded text for display; raw `message.content` is still passed to plugins. */
  displayContent?: string;
  className?: string;
  streaming: boolean;
  highlightQuery?: string;
}) {
  const registrations = usePluginRegistrations('messageRenderers');
  const [rendered, setRendered] = useState<RenderedMessage[]>([]);

  useEffect(() => {
    if (streaming || registrations.length === 0) {
      setRendered([]);
      return;
    }
    let active = true;
    void Promise.all(
      registrations.map(async (registration): Promise<RenderedMessage | null> => {
        try {
          const value = await frontendPluginRuntime.invoke(registration, {
            messageId: message.id,
            chatId: message.chatId,
            role: message.role,
            content: message.content,
          });
          if (!isRenderResult(value)) return null;
          return {
            registrationId: registration.registrationId,
            pluginName: registration.pluginName,
            text: value.text,
            placement: value.placement === 'replace' ? 'replace' : 'after',
          };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (active) setRendered(results.filter((item): item is RenderedMessage => item !== null));
    });
    return () => {
      active = false;
    };
  }, [message.chatId, message.content, message.id, message.role, registrations, streaming]);

  const replacement = rendered.findLast((item) => item.placement === 'replace');
  const additions = rendered.filter((item) => item.placement === 'after');
  const bodyText = replacement?.text ?? displayContent ?? message.content;
  const usePlainHighlight = highlightQuery !== undefined && highlightQuery.trim().length > 0;

  return (
    <>
      <div className={className} data-part="message-body">
        {usePlainHighlight ? (
          bodyText ? (
            <HighlightedText text={bodyText} query={highlightQuery} plain />
          ) : streaming ? (
            <span className={styles.typing}>...</span>
          ) : (
            ''
          )
        ) : (
          <MessageMarkdown text={bodyText} streaming={streaming} />
        )}
      </div>
      {additions.map((item) => (
        <aside
          key={item.registrationId}
          className={styles.annotation}
          data-component="plugin-message-renderer"
          data-plugin={item.pluginName}
        >
          {item.text}
        </aside>
      ))}
    </>
  );
}

function HighlightedText({
  text,
  query,
  plain = false,
}: {
  text: string;
  query?: string;
  plain?: boolean;
}) {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) {
    return plain ? <span className={styles.plainText}>{text}</span> : text;
  }

  const expression = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'giu');
  const foldedQuery = normalizedQuery.toLocaleLowerCase();
  const parts = text.split(expression).map((part, index) =>
    part.toLocaleLowerCase() === foldedQuery ? (
      <mark className={styles.searchMatch} key={`${index}-${part}`}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
  return plain ? <span className={styles.plainText}>{parts}</span> : parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isRenderResult(
  value: unknown,
): value is { text: string; placement?: 'replace' | 'after' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string' &&
    value.text.length <= 100_000 &&
    (!('placement' in value) ||
      value.placement === undefined ||
      value.placement === 'replace' ||
      value.placement === 'after')
  );
}
