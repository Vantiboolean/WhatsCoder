import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CustomSelect, type SelectOption } from './CustomSelect';

type SkillInfo = {
  name: string;
  path: string;
};

type AttachedImage = {
  dataUrl: string;
  name: string;
};

type PopupItem = {
  id: string;
  icon: 'command' | 'skill';
  name: string;
  desc: string;
  badge?: string;
  insert?: string;
};

type PopupMode = 'slash' | 'mention' | null;

const BUILT_IN_COMMANDS: PopupItem[] = [
  { id: 'cmd-model', icon: 'command', name: 'model', desc: 'composer.cmdModel' },
  { id: 'cmd-skills', icon: 'command', name: 'skills', desc: 'composer.cmdSkills' },
  { id: 'cmd-review', icon: 'command', name: 'review', desc: 'composer.cmdReview' },
  { id: 'cmd-compact', icon: 'command', name: 'compact', desc: 'composer.cmdCompact' },
  { id: 'cmd-clear', icon: 'command', name: 'clear', desc: 'composer.cmdClear' },
  { id: 'cmd-rename', icon: 'command', name: 'rename', desc: 'composer.cmdRename' },
  { id: 'cmd-diff', icon: 'command', name: 'diff', desc: 'composer.cmdDiff' },
  { id: 'cmd-status', icon: 'command', name: 'status', desc: 'composer.cmdStatus' },
  { id: 'cmd-plan', icon: 'command', name: 'plan', desc: 'composer.cmdPlan' },
  { id: 'cmd-fork', icon: 'command', name: 'fork', desc: 'composer.cmdFork' },
  { id: 'cmd-new', icon: 'command', name: 'new', desc: 'composer.cmdNew' },
  { id: 'cmd-help', icon: 'command', name: 'help', desc: 'composer.cmdHelp' },
];

export type ChatComposerHandle = {
  focus: () => void;
  setDraftText: (text: string) => void;
};

export type ModelSwitchPreview = {
  mode: 'fresh' | 'same-thread' | 'handoff';
  currentProviderLabel: string | null;
  targetProviderLabel: string;
  turnCount: number;
  willCompact: boolean;
  compactedMessages: number;
};

type Props = {
  className?: string;
  disabled?: boolean;
  isProcessing?: boolean;
  placeholder: string;
  historyKey: string;
  historySeed: string[];
  skills: SkillInfo[];
  modelOptions: SelectOption[];
  selectedModel: string;
  onSelectModel: (value: string) => void;
  modelSwitchPreview?: ModelSwitchPreview | null;
  reasoning: string;
  reasoningOptions: SelectOption[];
  onSelectReasoning: (value: string) => void;
  autonomyMode: string;
  autonomyOptions: SelectOption[];
  onSelectAutonomyMode: (value: string) => void;
  isUpdatingAutonomy: boolean;
  autonomyDetail: string | null;
  branchLabel: string;
  contextUsage: { percent: number; usedTokens: number } | null;
  onSubmit: (payload: { text: string; attachedImages: AttachedImage[] }) => void | Promise<void>;
  onExecuteCommand: (command: string) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  backendType?: 'codex' | 'claude';
};

function ComposerImpl({
  className,
  disabled,
  isProcessing,
  placeholder,
  historyKey,
  historySeed,
  skills,
  modelOptions,
  selectedModel,
  onSelectModel,
  modelSwitchPreview,
  reasoning,
  reasoningOptions,
  onSelectReasoning,
  autonomyMode,
  autonomyOptions,
  onSelectAutonomyMode,
  isUpdatingAutonomy,
  autonomyDetail,
  branchLabel,
  contextUsage,
  onSubmit,
  onExecuteCommand,
  onInterrupt,
  backendType,
}: Props, ref: React.ForwardedRef<ChatComposerHandle>) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const [inputText, setInputText] = useState('');
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [messageHistory, setMessageHistory] = useState<string[]>(historySeed);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const resizeTextarea = useCallback((maxHeight = 240) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  const setDraftText = useCallback((text: string) => {
    setInputText(text);
    setHistoryIdx(-1);
    requestAnimationFrame(() => {
      resizeTextarea();
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.selectionStart = text.length;
      textarea.selectionEnd = text.length;
    });
  }, [resizeTextarea]);

  useImperativeHandle(ref, () => ({
    focus: focusComposer,
    setDraftText,
  }), [focusComposer, setDraftText]);

  useEffect(() => {
    setInputText('');
    setAttachedImages([]);
    setSlashOpen(false);
    setSlashIdx(0);
    setMessageHistory(historySeed);
    setHistoryIdx(-1);
    requestAnimationFrame(() => resizeTextarea());
  }, [historyKey, historySeed, resizeTextarea]);

  const mentionItems = useMemo(
    () =>
      skills.map((skill) => ({
        id: `skill-${skill.name}`,
        icon: 'skill' as const,
        name: skill.name,
        desc: skill.path.split('/').pop() || skill.path,
        badge: t('composer.skill'),
        insert: `$${skill.name}`,
      })),
    [skills, t],
  );

  const popupMode: PopupMode = slashOpen
    ? inputText.startsWith('/')
      ? 'slash'
      : inputText.includes('$')
        ? 'mention'
        : null
    : null;

  const popupFilter = popupMode === 'slash'
    ? inputText.slice(1).toLowerCase()
    : popupMode === 'mention'
      ? (inputText.match(/\$([^\s]*)$/)?.[1] || '').toLowerCase()
      : '';

  const popupItems = useMemo(() => {
    const source = popupMode === 'slash' ? BUILT_IN_COMMANDS : mentionItems;
    if (!popupFilter) {
      return source;
    }
    return source.filter((item) => {
      const descText = item.icon === 'command' ? t(item.desc) : item.desc;
      return (
        item.name.toLowerCase().includes(popupFilter) ||
        descText.toLowerCase().includes(popupFilter)
      );
    });
  }, [mentionItems, popupFilter, popupMode, t]);

  const syncSlashState = useCallback((value: string) => {
    const hasSlashCommand = value.length > 0 && value.startsWith('/') && !value.includes('\n') && value.indexOf(' ') === -1;
    const hasMention = value.length > 0 && /\$[^\s]*$/.test(value);

    if (hasSlashCommand || hasMention) {
      setSlashOpen(true);
      setSlashIdx(0);
      return;
    }

    setSlashOpen(false);
  }, []);

  const appendDraftText = useCallback((value: string) => {
    setInputText((prev) => {
      const next = `${prev}${prev ? '\n' : ''}${value}`;
      requestAnimationFrame(() => resizeTextarea());
      return next;
    });
  }, [resizeTextarea]);

  const handleInputChange = useCallback((value: string) => {
    setInputText(value);
    setHistoryIdx(-1);
    syncSlashState(value);
    requestAnimationFrame(() => resizeTextarea());
  }, [resizeTextarea, syncSlashState]);

  const handleImageFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setAttachedImages((prev) => [...prev, { dataUrl, name: file.name }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleTextFile = useCallback((file: File, wrapAsCodeBlock: boolean) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      appendDraftText(wrapAsCodeBlock ? `\`\`\`\n${content}\n\`\`\`` : content);
    };
    reader.readAsText(file);
  }, [appendDraftText]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      return;
    }

    event.preventDefault();
    const file = imageItem.getAsFile();
    if (file) {
      handleImageFile(file);
    }
  }, [handleImageFile]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    files.forEach((file) => {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
        return;
      }

      if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
        handleTextFile(file, false);
      }
    });
  }, [handleImageFile, handleTextFile]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    files.forEach((file) => {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
        return;
      }

      if (file.type.startsWith('text/') || /\.(txt|md|json|csv|xml|yaml|yml|js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|css|html)$/i.test(file.name)) {
        handleTextFile(file, true);
      }
    });
    event.target.value = '';
  }, [handleImageFile, handleTextFile]);

  const clearDraft = useCallback(() => {
    setInputText('');
    setAttachedImages([]);
    setSlashOpen(false);
    setSlashIdx(0);
    setHistoryIdx(-1);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
      }
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (disabled || submitInFlightRef.current) {
      return;
    }

    const text = inputText.trim();
    if (!text && attachedImages.length === 0) {
      return;
    }

    if (text) {
      setMessageHistory((prev) => [text, ...prev].slice(0, 50));
    }
    setHistoryIdx(-1);

    const nextAttachments = attachedImages;
    clearDraft();
    submitInFlightRef.current = true;
    try {
      await onSubmit({ text, attachedImages: nextAttachments });
    } finally {
      submitInFlightRef.current = false;
    }
  }, [attachedImages, clearDraft, disabled, inputText, onSubmit]);

  const handleExecuteCommand = useCallback(async (command: string) => {
    clearDraft();
    await onExecuteCommand(command);
  }, [clearDraft, onExecuteCommand]);

  const handlePopupSelect = useCallback(async (item: PopupItem) => {
    setSlashOpen(false);

    if (item.insert) {
      const mentionMatch = inputText.match(/\$[^\s]*$/);
      if (mentionMatch) {
        const before = inputText.slice(0, mentionMatch.index ?? 0);
        setDraftText(`${before}${item.insert} `);
      } else {
        setDraftText(`${item.insert} `);
      }
      return;
    }

    await handleExecuteCommand(item.name);
  }, [handleExecuteCommand, inputText, setDraftText]);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) {
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
      return;
    }

    if (event.key === 'ArrowUp' && !inputText && messageHistory.length > 0) {
      event.preventDefault();
      const next = Math.min(historyIdx + 1, messageHistory.length - 1);
      setHistoryIdx(next);
      setInputText(messageHistory[next]);
      requestAnimationFrame(() => resizeTextarea());
      return;
    }

    if (event.key === 'ArrowDown' && historyIdx >= 0) {
      event.preventDefault();
      const next = historyIdx - 1;
      if (next < 0) {
        setHistoryIdx(-1);
        setInputText('');
      } else {
        setHistoryIdx(next);
        setInputText(messageHistory[next]);
      }
      requestAnimationFrame(() => resizeTextarea());
    }
  }, [handleSubmit, historyIdx, inputText, messageHistory, resizeTextarea]);

  const handleSlashKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen || popupItems.length === 0) {
      return false;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSlashIdx((prev) => (prev + 1) % popupItems.length);
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSlashIdx((prev) => (prev - 1 + popupItems.length) % popupItems.length);
      return true;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      void handlePopupSelect(popupItems[slashIdx]);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSlashOpen(false);
      return true;
    }

    return false;
  }, [handlePopupSelect, popupItems, slashIdx, slashOpen]);

  const canSubmitInput = inputText.trim().length > 0 || attachedImages.length > 0;
  const modelSwitchCompactLabel = modelSwitchPreview?.willCompact
    ? `Compact ${modelSwitchPreview.compactedMessages} msg${modelSwitchPreview.compactedMessages === 1 ? '' : 's'}`
    : 'No compact';
  const modelSwitchPrimaryText = modelSwitchPreview
    ? modelSwitchPreview.mode === 'fresh'
      ? `Next send starts a new ${modelSwitchPreview.targetProviderLabel} thread`
      : modelSwitchPreview.mode === 'same-thread'
        ? `Next send stays in this ${modelSwitchPreview.targetProviderLabel} thread`
        : `Next send hands off from ${modelSwitchPreview.currentProviderLabel ?? 'the current thread'} to ${modelSwitchPreview.targetProviderLabel}`
    : null;

  return (
    <div className={className ?? 'bottom-bar'}>
      <div className="bottom-bar-input">
        {slashOpen && popupItems.length > 0 && (
          <div className="slash-popup">
            <div className="slash-popup-header">
              {popupMode === 'slash' ? t('composer.commands') : t('composer.skillsAndMentions')}
            </div>
            <div className="slash-popup-list">
              {popupItems.map((item, index) => (
                <button
                  key={item.id}
                  className={`slash-popup-item${index === slashIdx ? ' slash-popup-item--active' : ''}`}
                  onMouseEnter={() => setSlashIdx(index)}
                  onClick={() => { void handlePopupSelect(item); }}
                >
                  <span className={`slash-popup-icon${item.icon === 'skill' ? ' slash-popup-icon--skill' : ''}`}>
                    {item.icon === 'command' ? (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4,6 8,10 12,6" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="2" width="5" height="5" rx="1" />
                        <rect x="9" y="2" width="5" height="5" rx="1" />
                        <rect x="2" y="9" width="5" height="5" rx="1" />
                        <rect x="9" y="9" width="5" height="5" rx="1" />
                      </svg>
                    )}
                  </span>
                  <span className="slash-popup-info">
                    <span className="slash-popup-name">{popupMode === 'slash' ? '/' : '$'}{item.name}</span>
                    <span className="slash-popup-desc">
                      {item.icon === 'command' ? t(item.desc) : item.desc}
                    </span>
                  </span>
                  {item.badge && <span className="slash-popup-badge">{item.badge}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {attachedImages.length > 0 && (
          <div className="attached-images-preview">
            {attachedImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="attached-image-thumb">
                <img src={image.dataUrl} alt={image.name} />
                <button
                  className="attached-image-remove"
                  onClick={() => setAttachedImages((prev) => prev.filter((_, imageIndex) => imageIndex !== index))}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="2" y1="2" x2="8" y2="8" />
                    <line x1="8" y1="2" x2="2" y2="8" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {modelSwitchPreview && modelSwitchPrimaryText && (
          <div className="composer-switch-banner" role="status">
            <span className="composer-switch-banner__eyebrow">Model switch</span>
            <span className="composer-switch-banner__text">{modelSwitchPrimaryText}</span>
            <div className="composer-switch-banner__chips">
              <span className="composer-switch-banner__chip">
                {modelSwitchPreview.mode === 'fresh'
                  ? 'Fresh thread'
                  : `${modelSwitchPreview.turnCount} turn${modelSwitchPreview.turnCount === 1 ? '' : 's'} context`}
              </span>
              <span className={`composer-switch-banner__chip${modelSwitchPreview.willCompact ? ' composer-switch-banner__chip--accent' : ''}`}>
                {modelSwitchCompactLabel}
              </span>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="bottom-bar-textarea"
          value={inputText}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (!handleSlashKeyDown(event)) {
              handleInputKeyDown(event);
            }
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onPaste={handlePaste}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          title={t('composer.enterToSend')}
        />
        {inputText.length > 500 && <span className="char-count">{inputText.length}</span>}

        <div className="bottom-bar-footer">
          <div className="bottom-bar-footer-tools">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*,.txt,.md,.json,.csv,.xml,.yaml,.yml,.js,.ts,.jsx,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <button
              className="bb-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              title={t('composer.addFileOrImage')}
              disabled={disabled}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 9.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3" />
                <polyline points="10.5,5 8,2.5 5.5,5" />
                <line x1="8" y1="2.5" x2="8" y2="10.5" />
              </svg>
            </button>
            <button
              className="bb-icon-btn"
              onClick={() => setDraftText('/')}
              title={t('composer.insertSlashCommand')}
              disabled={disabled}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="10" y1="3" x2="6" y2="13" />
              </svg>
            </button>
            <span className="bottom-bar-divider" />
            {modelOptions.length > 0 && (
              <CustomSelect
                value={selectedModel}
                options={modelOptions}
                onChange={onSelectModel}
                title={t('composer.model')}
              />
            )}
            <CustomSelect
              value={reasoning}
              options={reasoningOptions}
              onChange={onSelectReasoning}
              title={t('composer.reasoning')}
            />
            {backendType !== 'claude' && (
              <CustomSelect
                value={autonomyMode}
                options={autonomyOptions}
                onChange={onSelectAutonomyMode}
                title={t('composer.permissionMode')}
                compact
              />
            )}
            {isUpdatingAutonomy && backendType !== 'claude' && (
              <span className="bottom-bar-label">{t('composer.saving')}</span>
            )}
          </div>
          <div className="bottom-bar-footer-right">
            <span className="bottom-bar-label">
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 1v3" /><path d="M5 6v3" /><path d="M2 7l3-3 3 3" />
              </svg>
              {branchLabel}
            </span>
            {contextUsage && (
              <span className={`bottom-bar-label bottom-bar-context${contextUsage.percent < 20 ? ' bottom-bar-context--low' : ''}`}>
                {contextUsage.percent}%
              </span>
            )}
            <div className="bottom-bar-actions">
              <button
                className={`bottom-bar-send${canSubmitInput ? ' bottom-bar-send--active' : ''}`}
                onClick={() => { void handleSubmit(); }}
                disabled={!canSubmitInput || disabled}
                title={isProcessing ? t('composer.sendFollowUp') : t('common.send')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {isProcessing && onInterrupt && (
                <button
                  className="bottom-bar-send bottom-bar-send--stop"
                  onClick={() => { void onInterrupt(); }}
                  title={t('common.stop')}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                    <rect x="2" y="2" width="10" height="10" rx="2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const ChatComposer = memo(forwardRef<ChatComposerHandle, Props>(ComposerImpl));
