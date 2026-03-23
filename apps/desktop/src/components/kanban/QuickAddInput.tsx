import { memo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { KanbanStatus } from '../../lib/kanbanDb';

export const QuickAddInput = memo(function QuickAddInput({
  status,
  onAdd,
}: {
  status: KanbanStatus;
  onAdd: (title: string, status: KanbanStatus) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onAdd(value.trim(), status);
    setValue('');
    inputRef.current?.focus();
  };

  if (!active) {
    return (
      <button className="kanban-quick-add-trigger" onClick={() => { setActive(true); setTimeout(() => inputRef.current?.focus(), 0); }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="6" y1="2" x2="6" y2="10" />
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
        {t('kanban.addIssue')}
      </button>
    );
  }

  return (
    <div className="kanban-quick-add">
      <input
        ref={inputRef}
        className="kanban-quick-add-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') { setValue(''); setActive(false); }
        }}
        onBlur={() => { if (!value.trim()) setActive(false); }}
        placeholder={t('kanban.quickAddPlaceholder')}
      />
    </div>
  );
});
