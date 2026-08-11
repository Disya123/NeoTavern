import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cx } from '../lib/cx.js';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  id,
  className,
  ...aria
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      data-component="switch"
      className={cx('st-switch', className)}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
    >
      <SwitchPrimitive.Thumb data-component="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
