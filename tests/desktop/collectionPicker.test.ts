import { describe, expect, test } from 'bun:test';

import {
  matchingCollections,
  pickerEntries,
  searchState,
} from '../../src/desktop/renderer/CollectionPicker';

const OPTIONS = [
  { slug: 'boredapeyachtclub', name: 'Bored Ape Yacht Club', image: null },
  { slug: 'mutant-ape-yacht-club', name: 'Mutant Ape Yacht Club', image: null },
  { slug: 'pudgypenguins', name: 'Pudgy Penguins', image: null },
];

describe('matchingCollections', () => {
  test.each([
    ['', ['boredapeyachtclub', 'mutant-ape-yacht-club', 'pudgypenguins']],
    ['ape', ['boredapeyachtclub', 'mutant-ape-yacht-club']],
    ['  PUDGY ', ['pudgypenguins']],
    ['mutant-ape', ['mutant-ape-yacht-club']],
    ['azuki', []],
  ])('%p matches %p', (query, slugs) => {
    expect(matchingCollections(OPTIONS, query).map(({ slug }) => slug)).toEqual(slugs);
  });
});

describe('pickerEntries', () => {
  test.each([
    ['', ['boredapeyachtclub', 'mutant-ape-yacht-club', 'pudgypenguins']],
    ['pudgypenguins', ['pudgypenguins']],
    ['ape', ['boredapeyachtclub', 'mutant-ape-yacht-club', 'ape']],
    [' sappy-seals ', ['sappy-seals']],
  ])('%p offers %p', (query, slugs) => {
    expect(pickerEntries(OPTIONS, query).map(({ slug }) => slug)).toEqual(slugs);
  });
});

describe('pickerEntries with a search answer', () => {
  const FOUND = [
    { slug: 'lilpudgys', name: 'Lil Pudgys', image: null },
    { slug: 'pudgyrods', name: 'Pudgy Rods', image: null },
  ];

  test.each([
    ['pudgy', ['lilpudgys', 'pudgyrods', 'pudgy']],
    ['lilpudgys', ['lilpudgys', 'pudgyrods']],
  ])('%p offers %p', (query, slugs) => {
    expect(pickerEntries(OPTIONS, query, FOUND).map(({ slug }) => slug)).toEqual(slugs);
  });
});

describe('searchState', () => {
  const FOUND = [{ slug: 'lilpudgys', name: 'Lil Pudgys', image: null }];

  test.each([
    ['no term', '', undefined, { found: undefined, searching: false }],
    ['no answer yet', 'pudgy', undefined, { found: undefined, searching: true }],
    [
      'an older answer',
      'pudgy',
      { query: 'pud', found: FOUND },
      { found: undefined, searching: true },
    ],
    ['an answer', 'pudgy', { query: 'pudgy', found: FOUND }, { found: FOUND, searching: false }],
    ['a failed search', 'pudgy', { query: 'pudgy' }, { found: undefined, searching: false }],
  ])('%s', (_case, term, answer, state) => {
    expect(searchState(term, answer)).toEqual(state);
  });
});
