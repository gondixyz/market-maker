import { type KeyboardEvent, useEffect, useId, useState } from 'react';

import type { CollectionOption } from '../api';

/** The options whose name or slug contains `query`, ignoring case; every option for no query. */
export const matchingCollections = (options: CollectionOption[], query: string) => {
  const needle = query.trim().toLowerCase();
  return needle
    ? options.filter(
        ({ name, slug }) => name.toLowerCase().includes(needle) || slug.includes(needle),
      )
    : options;
};

/** The name of the entry that picks the typed text as a slug. */
const TYPED_SLUG = 'Use this slug';

/** How long the picker waits after the last keystroke before it searches. */
export const SEARCH_DELAY_MS = 250;

/**
 * What the list offers for `query`: the collections the search `found` for it, or, until it
 * answers, the options matching it; then the typed text itself as a slug when it is not one of
 * them, so a collection neither lists can still be picked. The save-time validation of the slug
 * catches a typo, as it does for a slug typed by hand.
 */
export const pickerEntries = (
  options: CollectionOption[],
  query: string,
  found?: CollectionOption[],
): CollectionOption[] => {
  const matches = found ?? matchingCollections(options, query);
  const typedSlug = query.trim();
  const known = [...options, ...matches].some((option) => option.slug === typedSlug);
  return typedSlug && !known
    ? [...matches, { slug: typedSlug, name: TYPED_SLUG, image: null }]
    : matches;
};

/** The last search that settled: its term and what it found, `undefined` when it failed. */
export type SearchAnswer = { query: string; found?: CollectionOption[] };

/**
 * The search's state for `term`, given the last `answer`: what it `found`, `undefined` when there
 * is no term, no answer for it yet, or the search failed; and whether it is still `searching`,
 * which a failed search is not, so the picker falls back to its own options and says so.
 */
export const searchState = (term: string, answer?: SearchAnswer) => {
  const answered = answer?.query === term;
  return {
    found: term && answered ? answer?.found : undefined,
    searching: term !== '' && !answered,
  };
};

/**
 * What `search` found for `query`, asked `SEARCH_DELAY_MS` after it last changed, as `searchState`
 * describes it. An answer for an older query is dropped.
 */
const useSearch = (
  query: string | null,
  search: (query: string) => Promise<CollectionOption[]>,
) => {
  const [answer, setAnswer] = useState<SearchAnswer>();
  const term = query?.trim() ?? '';
  useEffect(() => {
    if (!term) return;
    let current = true;
    const timer = setTimeout(() => {
      search(term).then(
        (found) => current && setAnswer({ query: term, found }),
        () => current && setAnswer({ query: term }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term, search]);
  return searchState(term, answer);
};

export const Thumbnail = ({ option, size }: { option?: CollectionOption; size: number }) =>
  option?.image ? (
    <img className="thumbnail" src={option.image} alt="" width={size} height={size} />
  ) : (
    <span className="thumbnail placeholder" style={{ width: size, height: size }} aria-hidden />
  );

/**
 * The task's collection: a text box that lists the week's top collections by sales volume, each
 * with its image, and, once something is typed, searches every collection by name or slug.
 * `options` is `undefined` while they load; `null` when they could not be read, and the box then
 * takes a slug as typed. A slug neither lists can still be typed and picked, and a saved one still
 * shows, as itself. `onChange` gets the picked option too, so its name and image can be kept.
 */
export const CollectionPicker = ({
  value,
  options,
  disabled,
  search,
  onChange,
}: {
  value: string;
  options: CollectionOption[] | null | undefined;
  disabled: boolean;
  search: (query: string) => Promise<CollectionOption[]>;
  onChange: (slug: string, option?: CollectionOption) => void;
}) => {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const { found, searching } = useSearch(options === null ? null : query, search);
  if (options === null) {
    return (
      <input
        placeholder="slug, e.g. pudgypenguins"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  const selected = options?.find((option) => option.slug === value);
  const open = query !== null;
  const matches = open ? pickerEntries(options ?? [], query, found) : [];
  const pick = (option: CollectionOption) => {
    onChange(option.slug, option.name === TYPED_SLUG ? undefined : option);
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
    <span className="picker">
      <Thumbnail option={selected} size={20} />
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[highlighted] ? `${listId}-${highlighted}` : undefined
        }
        placeholder={options ? 'Search collections' : 'Loading collections…'}
        value={open ? query : selected?.name ?? value}
        disabled={disabled}
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
          {matches.map((option, index) => (
            <li
              key={option.slug}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.slug === value}
              className={index === highlighted ? 'highlighted' : ''}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
            >
              <Thumbnail option={option} size={28} />
              <span className="pickerNames">
                <span className="pickerName">{option.name}</span>
                <span className="pickerSlug">{option.slug}</span>
              </span>
            </li>
          ))}
          {searching && <li className="pickerEmpty">Searching…</li>}
          {matches.length === 0 && !searching && (
            <li className="pickerEmpty">
              {options ? 'No collection matches' : 'Loading collections…'}
            </li>
          )}
        </ul>
      )}
    </span>
  );
};
