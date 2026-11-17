import { describe, expect, test } from 'bun:test';

import { matchingNames, traitTypes, traitValues } from '../../src/desktop/renderer/traits';

const TRAITS = [
  { type: 'Background', value: 'Mint' },
  { type: 'Hat', value: 'Crown' },
  { type: 'Background', value: 'Blue' },
];

describe('trait options', () => {
  test.each([
    ['each type once, sorted', '', ['Background', 'Hat']],
    ['a saved type the list lacks', 'Eyes', ['Background', 'Eyes', 'Hat']],
  ])('types: %s', (_case, picked, types) => {
    expect(traitTypes(TRAITS, picked)).toEqual(types);
  });

  test.each([
    ['the values of the type, sorted', 'Background', '', ['Blue', 'Mint']],
    ['a saved value the list lacks', 'Background', 'Red', ['Blue', 'Mint', 'Red']],
    ['none for no type', '', '', []],
  ])('values: %s', (_case, type, picked, values) => {
    expect(traitValues(TRAITS, type, picked)).toEqual(values);
  });

  test.each([
    ['every name for no query', ' ', ['Blue', 'Mint', 'Sky Blue']],
    ['the names that contain it, ignoring case', 'blu', ['Blue', 'Sky Blue']],
    ['none when nothing matches', 'red', []],
  ])('matching: %s', (_case, query, names) => {
    expect(matchingNames(['Blue', 'Mint', 'Sky Blue'], query)).toEqual(names);
  });
});
