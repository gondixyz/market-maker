import type { TopCollection } from '../../gondi/api';
import type { CollectionOption } from '../api';
import { inlineImage } from './inlineImage';

/** How many collections the tasks' collection picker offers. */
export const PICKER_SIZE = 30;

/**
 * Collections GONDI shows as one across several contracts, the platform's shared contracts and
 * their wrappers: a collection bid on any one of them would buy from a mix of artists, so the
 * picker leaves them out, as it does the collections other contracts wrap.
 */
const FAMILY_SLUGS = new Set([
  'superrare',
  'superrare-v1',
  'wrappedsuperrare',
  'known-origin',
  'known-origin-abb3',
]);

const isPickable = (collection: TopCollection) =>
  !collection.wrapped && !FAMILY_SLUGS.has(collection.slug);

/**
 * The collections the tasks' collection picker offers: those the bot can trade with the most sales
 * volume over the last seven days, or, with `searchTerm`, the ones it matches, without those that
 * other contracts wrap or that GONDI shows as one family, each with its 128px WebP thumbnail
 * inlined. A thumbnail that cannot be inlined is left out, not the collection.
 */
export const pickableCollections = async (
  api: { topCollections(limit: number, searchTerm?: string): Promise<TopCollection[]> },
  { searchTerm, download = fetch }: { searchTerm?: string; download?: typeof fetch } = {},
): Promise<CollectionOption[]> => {
  const top = (await api.topCollections(PICKER_SIZE + FAMILY_SLUGS.size + 10, searchTerm)).filter(
    isPickable,
  );
  return Promise.all(
    top.slice(0, PICKER_SIZE).map(async ({ slug, name, imageUrl }) => ({
      slug,
      name,
      image: imageUrl
        ? await inlineImage(`${imageUrl}/size_128x128.webp`, download).catch(() => null)
        : null,
    })),
  );
};
