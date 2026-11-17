import { useEffect, useState } from 'react';

import type { Trait } from '../../engine/market';

/** `names` once each, sorted, with `picked` among them so a saved choice the list lacks shows. */
const optionsOf = (names: string[], picked: string) =>
  [...new Set(picked ? [...names, picked] : names)].sort((first, second) =>
    first.localeCompare(second),
  );

/** The trait types of `traits` for the trait bid's type select, `picked` included. */
export const traitTypes = (traits: Trait[], picked: string) =>
  optionsOf(
    traits.map((trait) => trait.type),
    picked,
  );

/** The values `traits` holds for `type`, for the trait bid's value select, `picked` included. */
export const traitValues = (traits: Trait[], type: string, picked: string) =>
  optionsOf(
    traits.filter((trait) => trait.type === type).map((trait) => trait.value),
    picked,
  );

/**
 * The traits of the collection `slug` names, read with `load` whenever it changes: `undefined`
 * while they load or with no collection, `null` when they could not be read, so the editor takes
 * the trait as typed instead. An answer for a collection no longer picked is dropped.
 */
export const useCollectionTraits = (
  slug: string,
  load: (slug: string) => Promise<Trait[]>,
): Trait[] | null | undefined => {
  const [answer, setAnswer] = useState<{ slug: string; traits: Trait[] | null }>();
  const picked = slug.trim();
  useEffect(() => {
    if (!picked) return;
    let current = true;
    load(picked).then(
      (traits) => current && setAnswer({ slug: picked, traits }),
      () => current && setAnswer({ slug: picked, traits: null }),
    );
    return () => {
      current = false;
    };
  }, [picked, load]);
  return answer?.slug === picked ? answer.traits : undefined;
};

/** The names that contain `query`, ignoring case; every name for no query. */
export const matchingNames = (names: string[], query: string) => {
  const needle = query.trim().toLowerCase();
  return needle ? names.filter((name) => name.toLowerCase().includes(needle)) : names;
};
