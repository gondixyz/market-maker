import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'bun:test';

import { EMPTY_TASKS, TasksStore } from '../../src/desktop/main/tasksStore';

let store: TasksStore;

beforeEach(async () => {
  store = new TasksStore(join(await mkdtemp(join(tmpdir(), 'tasks-')), 'tasks.json'));
});

const VALID = JSON.stringify({ version: 1, exposureLimit: '1', tasks: [] });

describe('TasksStore', () => {
  test('starts from an empty tasks file', async () => {
    expect(await store.text()).toBe(EMPTY_TASKS);
  });

  test('saves a valid file as written', async () => {
    expect(await store.save(VALID)).toEqual({ ok: true, warnings: [] });
    expect(await store.text()).toBe(VALID);
  });

  test('reports where an invalid file is wrong and keeps the previous one', async () => {
    await store.save(VALID);

    const result = await store.save(
      JSON.stringify({ version: 1, exposureLimit: 'lots', tasks: [] }),
    );

    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('exposureLimit:')] });
    expect(await store.text()).toBe(VALID);
  });

  test('saves a file with a thin margin and says why it is thin', async () => {
    const bid = {
      id: 'buy',
      kind: 'collectionBid',
      collection: 'pudgypenguins',
      pricing: { mode: 'outbid' },
      minPrice: '1',
      maxPrice: '2.5',
    };
    const listing = {
      id: 'sell',
      kind: 'listing',
      collection: 'pudgypenguins',
      pricing: { mode: 'undercut', amount: '0.01' },
      minPrice: '2.4',
      maxPrice: '3',
    };
    const text = JSON.stringify({ version: 1, exposureLimit: '1', tasks: [bid, listing] });

    expect(await store.save(text)).toEqual({
      ok: true,
      warnings: [expect.stringContaining('listing sell may sell at 2.4 ETH')],
    });
    expect(await store.text()).toBe(text);
  });

  test('reports a file that is not JSON', async () => {
    expect(await store.save('{')).toMatchObject({ ok: false });
  });
});
