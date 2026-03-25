interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

export function Separator({ orientation = 'horizontal', className }: SeparatorProps) {
  return (
    <div
      className={`ui-separator ui-separator--${orientation}${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation={orientation}
    />
  );
}
