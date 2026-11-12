import { describe, expect, mock, test } from 'bun:test';
import type { Gondi } from 'gondi';
import { zeroHash } from 'viem';

import { approvalOperator, SEAPORT } from '../src/gondi/market';

const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const OPENSEA_CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71';

const gondiReading = (result: readonly [string, boolean]) => {
  const readContract = mock(async () => result);
  return { gondi: { bcClient: { readContract } } as unknown as Gondi, readContract };
};

describe('approvalOperator', () => {
  test('is Seaport itself for the null conduit key, without reading the chain', async () => {
    const { gondi, readContract } = gondiReading([OPENSEA_CONDUIT, true]);

    expect(await approvalOperator(gondi, zeroHash)).toBe(SEAPORT);
    expect(readContract).not.toHaveBeenCalled();
  });

  test('is the conduit the controller names for a conduit key', async () => {
    const { gondi, readContract } = gondiReading([OPENSEA_CONDUIT, true]);

    expect(await approvalOperator(gondi, OPENSEA_CONDUIT_KEY)).toBe(OPENSEA_CONDUIT);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'getConduit', args: [OPENSEA_CONDUIT_KEY] }),
    );
  });

  test('refuses a conduit key no conduit was deployed for', async () => {
    const { gondi } = gondiReading([OPENSEA_CONDUIT, false]);

    await expect(approvalOperator(gondi, OPENSEA_CONDUIT_KEY)).rejects.toThrow(
      'no Seaport conduit',
    );
  });
});
