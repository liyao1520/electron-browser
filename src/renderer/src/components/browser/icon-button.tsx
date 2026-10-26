import type { ComponentProps } from 'react'

export function IconButton({
  label,
  className = '',
  ...props
}: ComponentProps<'button'> & { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    />
  )
}
