import { forwardRef, type InputHTMLAttributes } from 'react';

type InputVariant = 'default' | 'search';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: InputVariant;
  error?: boolean;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ variant = 'default', error, icon, className, ...props }, ref) => {
    const wrapperCls = [
      'ui-input-wrapper',
      variant === 'search' && 'ui-input-wrapper--search',
      error && 'ui-input-wrapper--error',
      className,
    ].filter(Boolean).join(' ');

    return (
      <div className={wrapperCls}>
        {icon && <span className="ui-input-icon">{icon}</span>}
        <input ref={ref} className="ui-input" {...props} />
      </div>
    );
  }
);

Input.displayName = 'Input';
