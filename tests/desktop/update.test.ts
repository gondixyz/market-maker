import { describe, expect, test } from 'bun:test';

import { availableUpdate } from '../../src/desktop/main/update';

const releaseServer = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('availableUpdate', () => {
  test.each([
    ['v0.3.0', '0.2.1', '0.3.0'],
    ['v0.2.2', '0.2.1', '0.2.2'],
    ['v1.0.0', '0.9.9', '1.0.0'],
    ['v0.10.0', '0.9.0', '0.10.0'],
    ['v0.2.1', '0.2.1', null],
    ['v0.2.0', '0.2.1', null],
    ['v0.1.9', '0.2.0', null],
  ])('latest %s against %s offers %p', async (tag, current, expected) => {
    expect(await availableUpdate(current, releaseServer({ tag_name: tag }))).toBe(expected);
  });

  test('rejects when GitHub refuses or answers a tag that is not a version', async () => {
    await expect(availableUpdate('0.2.1', releaseServer({}, 403))).rejects.toThrow('403');
    await expect(
      availableUpdate('0.2.1', releaseServer({ tag_name: 'nightly' })),
    ).rejects.toThrow();
  });
});
