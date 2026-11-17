import { type KeyboardEvent, useId, useState } from 'react';

import { matchingNames } from './traits';

/**
 * A trait type or value: a text box that lists `options` and narrows them to what is typed, drawn
 * in the page like `CollectionPicker` rather than as a native `<select>`, whose list on Linux can
 * open where the window was before it moved. `options` is `undefined` while there is nothing to
 * pick from, and the box then shows `placeholder` and stays disabled. Only a listed name is picked.
 */
export const TraitPicker = ({
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  options: string[] | undefined;
  placeholder: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) => {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const open = query !== null && options !== undefined;
  const matches = open ? matchingNames(options, query) : [];
  const pick = (name: string) => {
    onChange(name);
    setQuery(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setQuery('');
        setHighlighted(0);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => Math.min(Math.max(current + step, 0), matches.length - 1));
    } else if (event.key === 'Enter' && open && matches[highlighted]) {
      event.preventDefault();
      pick(matches[highlighted]);
    } else if (event.key === 'Escape') {
      setQuery(null);
    }
  };
  return (
    <span className="picker traitPicker">
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[highlighted] ? `${listId}-${highlighted}` : undefined
        }
        placeholder={open && value ? value : placeholder}
        value={open ? query : value}
        disabled={disabled || !options}
        onFocus={() => {
          setQuery('');
          setHighlighted(0);
        }}
        onBlur={() => setQuery(null)}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlighted(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="pickerList" id={listId} role="listbox">
          {matches.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={name === value}
              className={index === highlighted ? 'highlighted' : ''}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(name);
              }}
            >
              {name}
            </li>
          ))}
          {matches.length === 0 && <li className="pickerEmpty">Nothing matches</li>}
        </ul>
      )}
    </span>
  );
};
