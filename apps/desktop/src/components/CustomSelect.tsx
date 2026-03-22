import { useEffect, useRef, useState } from 'react';

export type SelectOption = {
  value: string;
  label: string;
  group?: string;
};

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  title?: string;
  compact?: boolean;
};

export function CustomSelect({ value, options, onChange, title, compact }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) {
      return;
    }

    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  let lastGroup: string | undefined;

  return (
    <div className={`csel${compact ? ' csel--compact' : ''}${open ? ' csel--open' : ''}`} ref={ref} title={title}>
      <button className="csel-trigger" onClick={() => setOpen(!open)}>
        <span className="csel-value">{current?.label ?? value}</span>
        <svg className="csel-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3l2 2 2-2" />
        </svg>
      </button>
      {open && (
        <div className="csel-menu">
          {options.map((option) => {
            const showGroupHeader = option.group && option.group !== lastGroup;
            lastGroup = option.group;
            return (
              <div key={option.value}>
                {showGroupHeader && (
                  <div className="csel-group-header">{option.group}</div>
                )}
                <button
                  className={`csel-option${option.value === value ? ' csel-option--active' : ''}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                  {option.value === value && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 6l2.5 2.5 4.5-5" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
