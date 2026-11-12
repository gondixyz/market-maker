import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { parseTasksText } from '../../src/desktop/main/tasksStore';
import {
  errorsByKey,
  fieldErrors,
  fileOf,
  formOf,
  newTask,
  positionsWithErrors,
  savedFormWith,
  type StrategyEntry,
  summaryOf,
  type TasksForm,
} from '../../src/desktop/renderer/tasksForm';
import { parseTasksFile } from '../../src/engine/task';

const LISTING = {
  id: 'pudgy-sell',
  kind: 'listing',
  collection: 'pudgypenguins',
  tokenId: '3950',
  pricing: { mode: 'undercut', steps: 2 },
  minPrice: '2',
  maxPrice: '3',
  expirationMinutes: 120,
};

const OUTBID_PERCENT = {
  id: 'argonauts-buy',
  kind: 'collectionBid',
  collection: 'argonauts',
  pricing: { mode: 'outbid', percent: 0.5 },
  minPrice: '0.3',
  maxPrice: '0.6',
  expirationMinutes: 60,
  quantity: 1,
  maxItems: 1,
  maxFloorPercent: 98,
};

const OPENSEA_LEVEL = {
  id: 'bayc-ad',
  kind: 'collectionBid',
  venue: 'opensea',
  collection: 'boredapeyachtclub',
  pricing: { mode: 'level', level: 5 },
  minPrice: '1',
  maxPrice: '5',
  expirationMinutes: 60,
  quantity: 1,
  maxItems: 1,
};

const fileWith = (fields: Record<string, unknown>) => ({
  version: 1,
  exposureLimit: '0.6',
  pollSeconds: 15,
  tasks: [],
  ...fields,
});

const withSince = (since: string) =>
  JSON.stringify(fileWith({ lossLimits: { dailyUsd: 50, weeklyUsd: 200, since } }));

const parsedFrom = (form: TasksForm) => parseTasksFile(JSON.parse(fileOf(form)));

const savedSince = (form: TasksForm) => JSON.parse(fileOf(form)).lossLimits.since;

describe('formOf and fileOf', () => {
  test('carry the example tasks file through the form unchanged', async () => {
    const text = await readFile(join(import.meta.dir, '../../tasks.example.json'), 'utf8');

    expect(parsedFrom(formOf(text))).toEqual(parseTasksFile(JSON.parse(text)));
  });

  test.each([
    ['a listing with every pricing field', LISTING],
    ['a bid that outbids by a percentage', OUTBID_PERCENT],
    ['an OpenSea bid at a competing level', OPENSEA_LEVEL],
    ['a disabled task', { ...OUTBID_PERCENT, enabled: false }],
  ])('carry %s through the form unchanged', (_name, task) => {
    const file = fileWith({ tasks: [task] });

    expect(parsedFrom(formOf(JSON.stringify(file)))).toEqual(parseTasksFile(file));
  });

  test.each([
    ['a loss start past midnight', '2026-11-05T15:30:00Z', '2026-11-05'],
    ['a loss start with an offset', '2026-11-05T02:00:00+09:00', '2026-11-04'],
  ])('show the UTC day of %s and save it unchanged', (_name, since, day) => {
    const form = formOf(withSince(since));

    expect(form.since).toBe(day);
    expect(savedSince(form)).toBe(since);
  });

  test('save midnight UTC of a newly picked loss start day', () => {
    const form = { ...formOf(withSince('2026-11-05T15:30:00Z')), since: '2026-11-07' };

    expect(savedSince(form)).toBe('2026-11-07T00:00:00Z');
  });

  test('leave empty optional fields out, so the schema defaults apply', () => {
    const form = { ...formOf(''), exposureLimit: '1', tasks: [newTask('collectionBid', [])] };
    form.tasks[0] = { ...form.tasks[0], collection: 'argonauts', minPrice: '0.1', maxPrice: '0.2' };

    expect(JSON.parse(fileOf(form)).tasks[0]).toEqual({
      id: 'bid-1',
      kind: 'collectionBid',
      collection: 'argonauts',
      pricing: { mode: 'outbid', steps: 1 },
      minPrice: '0.1',
      maxPrice: '0.2',
      expirationMinutes: 60,
      quantity: 1,
    });
  });

  test('round-trip a bid priced in steps under the floor', () => {
    const pricing = { mode: 'floor', steps: 2 };
    const form = formOf(JSON.stringify({ tasks: [{ kind: 'collectionBid', pricing }] }));

    expect(form.tasks[0]).toMatchObject({ pricingMode: 'floorSteps', steps: '2' });
    expect(JSON.parse(fileOf(form)).tasks[0].pricing).toEqual(pricing);
  });

  test('keep text that is not a number, for the schema to reject', () => {
    const form = { ...formOf(''), exposureLimit: '1', pollSeconds: 'often' };

    expect(JSON.parse(fileOf(form)).pollSeconds).toBe('often');
  });

  test('start an empty form from text that is not JSON', () => {
    expect(formOf('{ not json')).toMatchObject({ exposureLimit: '', tasks: [] });
  });
});

describe('summaryOf', () => {
  test.each([
    [
      'a bid that outbids by steps',
      OUTBID_PERCENT,
      { pricing: { mode: 'outbid', steps: 2 } },
      'Outbid by 2 steps · 0.3–0.6 WETH',
    ],
    ['a bid that outbids by a percentage', OUTBID_PERCENT, {}, 'Outbid by 0.5% · 0.3–0.6 WETH'],
    ['an OpenSea bid at a level', OPENSEA_LEVEL, {}, 'Bid level 5 · 1–5 WETH'],
    [
      'a listing under the cheapest one',
      LISTING,
      { pricing: { mode: 'undercut', steps: 1 } },
      'Undercut by 1 step · 2–3 ETH',
    ],
  ])('describes %s in one line', (_name, task, overrides, summary) => {
    const [form] = formOf(JSON.stringify(fileWith({ tasks: [{ ...task, ...overrides }] }))).tasks;

    expect(summaryOf(form)).toBe(summary);
  });
});

describe('savedFormWith', () => {
  const settings = formOf(JSON.stringify(fileWith({ tasks: [] })));
  const task = (id: string) => ({ ...newTask('collectionBid', []), id });
  const entries: StrategyEntry[] = [
    { key: 3, task: task('a-edited'), saved: task('a'), editing: true },
    { key: 5, task: task('b'), saved: task('b'), editing: false },
    { key: 8, task: task('new'), saved: null, editing: true },
  ];
  const ids = (change?: { key: number; task: ReturnType<typeof task> | null }) => {
    const { form, keys } = savedFormWith(settings, entries, change);
    return { ids: form.tasks.map((each) => each.id), keys };
  };

  test('writes every strategy as saved, leaving open edits out', () => {
    expect(ids()).toEqual({ ids: ['a', 'b'], keys: [3, 5] });
  });

  test("writes one strategy's edit in its place", () => {
    expect(ids({ key: 3, task: task('a-edited') })).toEqual({
      ids: ['a-edited', 'b'],
      keys: [3, 5],
    });
  });

  test('appends a strategy never saved', () => {
    expect(ids({ key: 8, task: task('new') })).toEqual({ ids: ['a', 'b', 'new'], keys: [3, 5, 8] });
  });

  test('leaves a deleted strategy out', () => {
    expect(ids({ key: 5, task: null })).toEqual({ ids: ['a'], keys: [3] });
  });
});

describe('errorsByKey', () => {
  test("keys a task's errors by its strategy, and leaves the settings' alone", () => {
    const errors = new Map([
      ['tasks.1.minPrice', 'expected an ETH amount'],
      ['exposureLimit', 'expected an ETH amount'],
    ]);

    expect([...errorsByKey(errors, [3, 8])]).toEqual([
      ['tasks.8.minPrice', 'expected an ETH amount'],
      ['exposureLimit', 'expected an ETH amount'],
    ]);
  });
});

describe('positionsWithErrors', () => {
  test('names each task an error belongs to, and none for the settings', () => {
    const errors = new Map([
      ['tasks.2.minPrice', 'expected an ETH amount'],
      ['tasks.2', 'minPrice must not exceed maxPrice'],
      ['tasks.0.collection', 'required'],
      ['exposureLimit', 'expected an ETH amount'],
    ]);

    expect([...positionsWithErrors(errors)].sort()).toEqual([0, 2]);
  });
});

describe('newTask', () => {
  test.each([
    [['bid-2'], 'bid-1'],
    [['bid-1', 'bid-2'], 'bid-3'],
    [['listing-1'], 'bid-1'],
  ])('given the ids %p, picks %p', (takenIds, id) => {
    expect(newTask('collectionBid', takenIds).id).toBe(id);
  });
});

const LOSS_LIMITS = { dailyUsd: 50, weeklyUsd: 200, since: '2026-11-05T00:00:00Z' };

describe('fieldErrors', () => {
  test.each([
    [
      'a bid pricing rule out of range',
      { tasks: [{ ...OUTBID_PERCENT, pricing: { mode: 'outbid', percent: 150 } }] },
      'tasks.0.percent',
    ],
    [
      'a listing pricing field out of range',
      { tasks: [{ ...LISTING, pricing: { mode: 'floor', percent: 2000 } }] },
      'tasks.0.percent',
    ],
    [
      'a task amount that is not one',
      { tasks: [{ ...LISTING, minPrice: 'cheap' }] },
      'tasks.0.minPrice',
    ],
    ['a min price over the max price', { tasks: [{ ...LISTING, minPrice: '5' }] }, 'tasks.0'],
    ['a loss cap out of range', { lossLimits: { ...LOSS_LIMITS, dailyUsd: -1 } }, 'dailyUsd'],
    ['a settings amount that is not one', { exposureLimit: 'lots' }, 'exposureLimit'],
    ['two tasks with one id', { tasks: [LISTING, LISTING] }, 'file'],
    [
      'a level out of range',
      { tasks: [{ ...OPENSEA_LEVEL, pricing: { mode: 'level', level: 0 } }] },
      'tasks.0.level',
    ],
    [
      'an OpenSea bid without maxItems',
      { tasks: [{ ...OPENSEA_LEVEL, maxItems: undefined }] },
      'tasks.0.maxItems',
    ],
  ])('keys the schema error for %s by %p', (_name, fields, key) => {
    const result = parseTasksText(fileOf(formOf(JSON.stringify(fileWith(fields)))));

    expect(result.ok ? [] : [...fieldErrors(result.errors).keys()]).toContain(key);
  });
});
