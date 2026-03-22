import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThreadDetail } from '@codex-mobile/shared';
import { ThreadView } from './ThreadView';

type PendingMessage = {
  id: string;
  text: string;
};

type Props = {
  thread: ThreadDetail;
  isSending: boolean;
  isAgentActive: boolean;
  isTurnsLoading?: boolean;
  showRawJson: boolean;
  onToggleRawJson: () => void;
  overrideIsProcessing?: boolean;
  pendingMessages: PendingMessage[];
  statusHint: string | null;
  contextUsage: { percent: number; usedTokens: number } | null;
  turnStartTime: number | null;
  onResend?: (text: string) => void;
};

const ProcessingStatus = memo(function ProcessingStatus({
  active,
  startedAt,
  contextUsage,
  statusHint,
}: {
  active: boolean;
  startedAt: number | null;
  contextUsage: { percent: number; usedTokens: number } | null;
  statusHint: string | null;
}) {
  const { t } = useTranslation();
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!active || !startedAt) {
      setElapsedSec(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };

    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  if (!active) {
    return null;
  }

  return (
    <div className="status-indicator">
      <span className="status-indicator-dot" />
      <span className="status-indicator-text">{t('workspace.working')}</span>
      <span className="status-indicator-time">
        {elapsedSec > 0 ? t('workspace.elapsedSeconds', { count: elapsedSec }) : ''}
      </span>
      {contextUsage && (
        <span className="status-indicator-context">
          {t('workspace.contextLeft', { percent: contextUsage.percent })}
        </span>
      )}
      {statusHint && <span className="status-indicator-hint">{statusHint}</span>}
    </div>
  );
});

export const ThreadWorkspace = memo(function ThreadWorkspace({
  thread,
  isSending,
  isAgentActive,
  isTurnsLoading,
  showRawJson,
  onToggleRawJson,
  overrideIsProcessing,
  pendingMessages,
  statusHint,
  contextUsage,
  turnStartTime,
  onResend,
}: Props) {
  const { t } = useTranslation();
  const lastTurn = thread.turns?.[thread.turns.length - 1];
  const isProcessing =
    overrideIsProcessing ?? Boolean(isSending || isAgentActive || lastTurn?.status === 'inProgress');

  return (
    <>
      <ThreadView
        thread={thread}
        isSending={isSending}
        isAgentActive={isAgentActive}
        isTurnsLoading={isTurnsLoading}
        showRawJson={showRawJson}
        onToggleRawJson={onToggleRawJson}
        overrideIsProcessing={overrideIsProcessing}
        onResend={onResend}
      />
      {pendingMessages.length > 0 && isProcessing && (
        <div className="pending-input-preview">
          <span className="pending-input-label">
            {t('workspace.queuedMessages', { count: pendingMessages.length })}
          </span>
          {pendingMessages.slice(0, 3).map((message) => (
            <span key={message.id} className="pending-input-msg">
              {message.text.length > 60 ? `${message.text.slice(0, 60)}...` : message.text}
            </span>
          ))}
          {pendingMessages.length > 3 && (
            <span className="pending-input-more">
              {t('workspace.more', { count: pendingMessages.length - 3 })}
            </span>
          )}
        </div>
      )}
      <ProcessingStatus
        active={isProcessing}
        startedAt={turnStartTime}
        contextUsage={contextUsage}
        statusHint={statusHint}
      />
    </>
  );
});
