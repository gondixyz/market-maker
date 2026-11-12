import { describe, expect, mock, test } from 'bun:test';

import { pickableCollections, PICKER_SIZE } from '../../src/desktop/main/collections';
import type { TopCollection } from '../../src/gondi/api';

const collection = (slug: string, overrides: Partial<TopCollection> = {}): TopCollection => ({
  slug,
  name: slug.toUpperCase(),
  imageUrl: `https://cdn.test/${slug}`,
  wrapped: false,
  ...overrides,
});

const pngServer = () =>
  mock(
    async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }),
  ) as unknown as typeof fetch;

describe('pickableCollections', () => {
  test('leaves out wrapped collections and shared-contract families, keeping the ranking', async () => {
    const api = {
      topCollections: async () => [
        collection('cryptopunks', { wrapped: true }),
        collection('autoglyphs'),
        collection('superrare'),
        collection('known-origin'),
        collection('pudgypenguins'),
      ],
    };

    expect(
      (await pickableCollections(api, { download: pngServer() })).map(({ slug }) => slug),
    ).toEqual(['autoglyphs', 'pudgypenguins']);
  });

  test('inlines each 128px WebP thumbnail, and keeps a collection whose thumbnail fails', async () => {
    const download = mock(async (url: string) =>
      url.includes('azuki')
        ? new Response('', { status: 403 })
        : new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch;
    const api = {
      topCollections: async () => [
        collection('milady'),
        collection('azuki'),
        collection('x', { imageUrl: null }),
      ],
    };

    expect(await pickableCollections(api, { download })).toEqual([
      { slug: 'milady', name: 'MILADY', image: 'data:image/png;base64,AQI=' },
      { slug: 'azuki', name: 'AZUKI', image: null },
      { slug: 'x', name: 'X', image: null },
    ]);
    expect(download).toHaveBeenCalledWith('https://cdn.test/milady/size_128x128.webp');
  });

  test(`offers at most ${PICKER_SIZE}`, async () => {
    const api = {
      topCollections: async (limit: number) =>
        Array.from({ length: limit }, (_each, index) => collection(`c${index}`)),
    };

    expect(await pickableCollections(api, { download: pngServer() })).toHaveLength(PICKER_SIZE);
  });

  test('passes the search term on', async () => {
    const topCollections = mock(async (_limit: number, _searchTerm?: string) => [
      collection('pudgypenguins'),
    ]);

    await pickableCollections({ topCollections }, { searchTerm: 'pudgy', download: pngServer() });

    expect(topCollections).toHaveBeenCalledWith(expect.any(Number), 'pudgy');
  });
});
