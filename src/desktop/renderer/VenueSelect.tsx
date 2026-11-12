import { type KeyboardEvent, useId, useState } from 'react';

import { type Venue, VENUES } from '../../engine/market';
import { GondiMark, OpenSeaMark } from './VenueIcons';

export const VENUE_NAMES: Record<Venue, string> = { gondi: 'GONDI', opensea: 'OpenSea' };

/** The venue's mark beside its name. */
export const VenueLabel = ({ venue, size = 18 }: { venue: Venue; size?: number }) => (
  <span className="venueLabel">
    {venue === 'opensea' ? <OpenSeaMark size={size} /> : <GondiMark size={size} />}
    {VENUE_NAMES[venue]}
  </span>
);

/**
 * Where a bid is posted, as a select whose options show each venue's mark: a native `<select>`
 * draws text only, so this is a button and a listbox, keyboard included (arrows, Enter, Escape).
 */
export const VenueSelect = ({
  value,
  disabled,
  onChange,
}: {
  value: Venue;
  disabled: boolean;
  onChange: (venue: Venue) => void;
}) => {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const openList = () => {
    setHighlighted(VENUES.indexOf(value));
    setOpen(true);
  };
  const pick = (venue: Venue) => {
    onChange(venue);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openList();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => Math.min(Math.max(current + step, 0), VENUES.length - 1));
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      pick(VENUES[highlighted]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };
  return (
    <span className="picker venueSelect">
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
        <VenueLabel venue={value} />
      </button>
      {open && (
        <ul className="pickerList" id={listId} role="listbox">
          {VENUES.map((venue, index) => (
            <li
              key={venue}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={venue === value}
              className={index === highlighted ? 'highlighted' : ''}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(venue);
              }}
            >
              <VenueLabel venue={venue} />
            </li>
          ))}
        </ul>
      )}
    </span>
  );
};
