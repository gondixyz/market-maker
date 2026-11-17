import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';

/**
 * A select drawn in the page: a button and a listbox, keyboard included (arrows, Enter, Escape).
 * A native `<select>` opens its list in a window of its own, which on Linux can stay where the app
 * window was before it moved, and draws text only.
 */
export const Select = <Option extends string>({
  value,
  options,
  labelOf,
  disabled,
  onChange,
}: {
  value: Option;
  options: readonly Option[];
  labelOf: (option: Option) => ReactNode;
  disabled: boolean;
  onChange: (option: Option) => void;
}) => {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const openList = () => {
    setHighlighted(Math.max(options.indexOf(value), 0));
    setOpen(true);
  };
  const pick = (option: Option) => {
    onChange(option);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openList();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => Math.min(Math.max(current + step, 0), options.length - 1));
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      pick(options[highlighted]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };
  return (
    <span className="picker select">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      >
        {labelOf(value)}
      </button>
      {open && (
        <ul className="pickerList" id={listId} role="listbox">
          {options.map((option, index) => (
            <li
              key={option}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option === value}
              className={index === highlighted ? 'highlighted' : ''}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
            >
              {labelOf(option)}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
};
