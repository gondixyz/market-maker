import { describe, expect, mock, test } from 'bun:test';

import { MAX_IMAGE_BYTES } from '../../src/desktop/main/inlineImage';
import { walletProfile } from '../../src/desktop/main/profile';

const WALLET = '0x3c5F7A1B9e2D4c6A8b0E1f3D5c7B9a2E4d6F8a1C';

const apiWith = (pictureUrl: string | null) => ({
  profile: async () => ({ name: 'mauro', pictureUrl }),
});

const serving = (body: BodyInit, contentType: string, status = 200) =>
  mock(
    async () => new Response(body, { status, headers: { 'content-type': contentType } }),
  ) as unknown as typeof fetch;

describe('walletProfile', () => {
  test('inlines the picture as a data URL', async () => {
    const download = serving(new Uint8Array([137, 80, 78, 71]), 'image/png');

    expect(await walletProfile(apiWith('https://img.test/p.png'), WALLET, download)).toEqual({
      name: 'mauro',
      picture: 'data:image/png;base64,iVBORw==',
    });
  });

  test('downloads nothing for a wallet without a picture', async () => {
    const download = serving('', 'image/png');

    expect(await walletProfile(apiWith(null), WALLET, download)).toEqual({
      name: 'mauro',
      picture: null,
    });
    expect(download).not.toHaveBeenCalled();
  });

  test.each([
    ['a body that is not an image', serving('<html>', 'text/html'), 'https://img.test/p'],
    ['a failed download', serving('', 'image/png', 404), 'https://img.test/p.png'],
    [
      'a picture over the size cap',
      serving(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/png'),
      'https://img.test/p.png',
    ],
    ['a URL that is not http(s)', serving('', 'image/png'), 'file:///etc/passwd'],
  ])('keeps the name and drops the picture for %s', async (_case, download, url) => {
    expect(await walletProfile(apiWith(url), WALLET, download)).toEqual({
      name: 'mauro',
      picture: null,
    });
  });
});
