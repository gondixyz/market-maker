import { describe, expect, test } from 'bun:test';
import type { Gondi } from 'gondi';
import { type Address, createWalletClient, type Hash, http, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import type { GondiApi } from '../src/gondi/api';
import { WETH } from '../src/gondi/market';
import { OpenSeaApi, SEAPORT_PROTOCOL } from '../src/opensea/api';
import { competingBidLevels, OpenSeaMarket, requiredFees } from '../src/opensea/market';
import { eth } from './fakeMarket';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const OTHER: Address = '0x2400c5227e81603f4166c30b10b7779f6054a2aa';
const BAYC: Address = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d';
const OPENSEA_FEE: Address = '0x0000a26b00c1f0df003000390027140000faa719';
const SIGNED_ZONE: Address = '0x000056f7000000ece9003ca63978907a00ffd100';
const ORDER_HASH: Hash = '0xfb869d57bdf949b1725754b74449c75ece02e7e6b8f367e7d82efaaeec554623';

/** An offer as `offers/collection/{slug}` lists it (trimmed from a production BAYC offer). */
const offerJson = ({
  offerer = OTHER,
  total = '16680000000000000000',
  quantity = '3',
  slug = 'boredapeyachtclub',
  traits = null as unknown[] | null,
  startTime = '1794349132',
} = {}) => ({
  order_hash: ORDER_HASH,
  chain: 'ethereum',
  protocol_data: {
    parameters: {
      offerer,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: '0',
          startAmount: total,
          endAmount: total,
        },
      ],
      consideration: [
        {
          itemType: 4,
          token: BAYC,
          identifierOrCriteria: '0',
          startAmount: quantity,
          endAmount: quantity,
          recipient: offerer,
        },
      ],
      startTime,
      endTime: '1794350932',
      orderType: 3,
      zone: SIGNED_ZONE,
      zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      salt: '0x0',
      conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
      totalOriginalConsiderationItems: 1,
      counter: '0',
    },
    signature: null,
  },
  remaining_quantity: Number(quantity),
  criteria: { collection: { slug }, traits, numeric_traits: null },
  status: 'ACTIVE',
});

const COLLECTION = {
  fees: [
    { fee: 1, recipient: OPENSEA_FEE, required: true },
    { fee: 5, recipient: OTHER, required: false },
  ],
  collection_offers_enabled: true,
};

type Request = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** An OpenSea API answering each path from `routes` (matched by prefix), recording every request. */
const fakeOpenSea = (routes: Record<string, unknown>) => {
  const requests: Request[] = [];
  const send = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.opensea.io/api/v2/', '');
    requests.push({
      url: path,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const route = Object.keys(routes)
      .sort((first, second) => second.length - first.length)
      .find((prefix) => path.startsWith(prefix));
    return route
      ? Response.json(routes[route])
      : Response.json({ errors: ['not found'] }, { status: 404 });
  }) as unknown as typeof fetch;
  return { api: new OpenSeaApi('test-key', send), requests };
};

describe('competingBidLevels', () => {
  test('lists each other price per item once, best first, the wallet’s own left out', async () => {
    const { api } = fakeOpenSea({
      'offers/collection/boredapeyachtclub': {
        offers: [
          offerJson({ total: '5000000000000000000', quantity: '1' }),
          offerJson({ total: '16680000000000000000', quantity: '3' }),
          offerJson({ total: '5560000000000000000', quantity: '1' }),
          offerJson({ offerer: account.address, total: '9000000000000000000', quantity: '1' }),
        ],
      },
    });

    const offers = await api.collectionOffers('boredapeyachtclub');

    expect(competingBidLevels(offers, account.address)).toEqual([eth('5.56'), eth('5')]);
  });
});

describe('requiredFees', () => {
  test('pays each required fee in WETH, floored per item, for every item', () => {
    expect(requiredFees(COLLECTION, 1_000_000_001n, 3)).toEqual([
      {
        itemType: 1,
        token: WETH,
        identifierOrCriteria: '0',
        startAmount: 30_000_000n,
        endAmount: 30_000_000n,
        recipient: OPENSEA_FEE,
      },
    ]);
  });
});

describe('OpenSeaApi', () => {
  test('reads the wallet’s collection offers only, leaving out its trait offers', async () => {
    const { api } = fakeOpenSea({
      'offers/collection/boredapeyachtclub/all': {
        offers: [
          offerJson({ offerer: account.address, startTime: '1' }),
          offerJson({ offerer: account.address, startTime: '2', traits: [{ type: 'Fur' }] }),
        ],
      },
    });

    const offers = await api.ownOffers('boredapeyachtclub', account.address);

    expect(offers.map((offer) => offer.protocol_data.parameters.startTime)).toEqual([1]);
  });

  test('sends the key and surfaces OpenSea’s reason for a refusal', async () => {
    const { api, requests } = fakeOpenSea({});

    await expect(api.collection('nothing')).rejects.toThrow('OpenSea answered 404: not found');
    expect(requests[0].headers['x-api-key']).toBe('test-key');
  });
});

const BUILT = {
  partialParameters: {
    consideration: [
      {
        itemType: 4,
        token: BAYC,
        identifierOrCriteria: '0',
        startAmount: '2',
        endAmount: '2',
        recipient: account.address,
      },
    ],
    zone: SIGNED_ZONE,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  },
  criteria: { collection: { slug: 'boredapeyachtclub' } },
};

/**
 * An `OpenSeaMarket` on a real local key, with the chain and GONDI reads stubbed; `clock.now` is
 * the moment it reads as now.
 */
const marketWith = (routes: Record<string, unknown>, clock = { now: new Date() }) => {
  const opensea = fakeOpenSea({
    'collections/boredapeyachtclub': COLLECTION,
    'offers/build': BUILT,
    offers: { order_hash: ORDER_HASH },
    'offers/collection/boredapeyachtclub': { offers: [] },
    ...routes,
  });
  const gondi = {
    account,
    wallet: createWalletClient({ account, chain: mainnet, transport: http('http://localhost:1') }),
    bcClient: { readContract: async () => 7n },
    currencyBalance: async () => eth('10'),
    currencyAllowance: async () => eth('10'),
  } as unknown as Gondi;
  const gondiApi = {
    collectionMarket: async () => ({ contractAddress: BAYC, floorPrice: eth('6') }),
  } as unknown as GondiApi;
  return {
    market: new OpenSeaMarket(gondi, opensea.api, gondiApi, () => clock.now),
    requests: opensea.requests,
  };
};

const SCOPE = { kind: 'collection', slug: 'boredapeyachtclub', venue: 'opensea' } as const;

describe('OpenSeaMarket', () => {
  test('posts an offer the wallet signed, paying the required fee out of its WETH', async () => {
    const { market, requests } = marketWith({});

    await market.placeBid({
      scope: { kind: 'collection', slug: 'boredapeyachtclub', venue: 'opensea' },
      price: eth('5'),
      quantity: 2,
      expiration: new Date('2030-01-01T00:00:00Z'),
    });

    const posted = requests.find((request) => request.url === 'offers')?.body as {
      protocol_data: { parameters: Record<string, unknown>; signature: Hash };
    };
    const { parameters, signature } = posted.protocol_data;
    const signer = await recoverTypedDataAddress({
      domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: SEAPORT_PROTOCOL },
      types: {
        OrderComponents: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offer', type: 'OfferItem[]' },
          { name: 'consideration', type: 'ConsiderationItem[]' },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
        OfferItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
        ],
        ConsiderationItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      },
      primaryType: 'OrderComponents',
      message: parameters as never,
      signature,
    });

    expect({
      signer,
      offered: (parameters.offer as { startAmount: string }[])[0].startAmount,
      fees: (parameters.consideration as { recipient: string; startAmount: string }[])
        .slice(1)
        .map(({ recipient, startAmount }) => [recipient, startAmount]),
      counter: parameters.counter,
    }).toEqual({
      signer: account.address,
      offered: eth('10').toString(),
      fees: [[OPENSEA_FEE, eth('0.1').toString()]],
      counter: '7',
    });
  });

  test('reads the wallet’s offers and cancels one with a signature over its order hash', async () => {
    const { market, requests } = marketWith({
      'offers/collection/boredapeyachtclub/all': {
        offers: [
          offerJson({ offerer: account.address, quantity: '1', total: '5000000000000000000' }),
        ],
      },
      [`orders/chain/ethereum/protocol/${SEAPORT_PROTOCOL}/${ORDER_HASH}/cancel`]: {
        last_signature_issued_valid_until: '0',
      },
    });

    const { ownBids } = await market.snapshot({
      kind: 'collection',
      slug: 'boredapeyachtclub',
      venue: 'opensea',
    });
    await market.cancelBids(ownBids);

    const cancel = requests.find((request) => request.url.endsWith('/cancel'));
    const signer = await recoverTypedDataAddress({
      domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: SEAPORT_PROTOCOL },
      types: { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] },
      primaryType: 'OrderHash',
      message: { orderHash: ORDER_HASH },
      signature: (cancel?.body as { offererSignature: Hash }).offererSignature,
    });
    expect([ownBids.map((bid) => bid.price), signer]).toEqual([[eth('5')], account.address]);
  });

  test('takes a cancel of an offer only five and a half minutes after it starts', async () => {
    const { market } = marketWith({
      'offers/collection/boredapeyachtclub/all': {
        offers: [offerJson({ offerer: account.address, quantity: '1', startTime: '1794349132' })],
      },
    });
    const placed = await market.placeBid({
      scope: SCOPE,
      price: eth('5'),
      quantity: 1,
      expiration: new Date('2030-01-01T01:00:00Z'),
    });
    const [listed] = (await market.snapshot(SCOPE)).ownBids;

    expect([listed.cancellableFrom, placed.cancellableFrom]).toEqual([
      new Date((1794349132 + 330) * 1_000),
      new Date(placed.placedAt.getTime() + 330_000),
    ]);
  });

  describe('an offer OpenSea has not listed yet', () => {
    const placeAndRead = async (listed: unknown[], secondsLater: number) => {
      const clock = { now: new Date('2030-01-01T00:00:00Z') };
      const routes: Record<string, unknown> = {
        'offers/collection/boredapeyachtclub/all': { offers: [] },
        [`orders/chain/ethereum/protocol/${SEAPORT_PROTOCOL}/${ORDER_HASH}/cancel`]: {},
      };
      const { market } = marketWith(routes, clock);
      const placed = await market.placeBid({
        scope: SCOPE,
        price: eth('5'),
        quantity: 1,
        expiration: new Date('2030-01-01T01:00:00Z'),
      });
      routes['offers/collection/boredapeyachtclub/all'] = { offers: listed };
      clock.now = new Date(clock.now.getTime() + secondsLater * 1_000);
      return { market, placed, ownBids: (await market.snapshot(SCOPE)).ownBids };
    };

    test('counts as the wallet’s own until OpenSea lists it, so no round posts it twice', async () => {
      const { placed, ownBids } = await placeAndRead([], 30);

      expect(ownBids).toEqual([placed]);
    });

    test('counts once when OpenSea lists it', async () => {
      const listed = offerJson({
        offerer: account.address,
        quantity: '1',
        total: '5000000000000000000',
      });

      const { ownBids } = await placeAndRead([listed], 30);

      expect(ownBids.map((bid) => bid.id)).toEqual([ORDER_HASH]);
    });

    test('is forgotten once OpenSea had long enough to list it', async () => {
      const { ownBids } = await placeAndRead([], 180);

      expect(ownBids).toEqual([]);
    });

    test('is forgotten once cancelled', async () => {
      const { market, placed } = await placeAndRead([], 30);

      await market.cancelBids([placed]);

      expect((await market.snapshot(SCOPE)).ownBids).toEqual([]);
    });
  });

  test('refuses to run off mainnet', () => {
    const gondi = {
      account,
      wallet: createWalletClient({ account, chain: { ...mainnet, id: 31337 }, transport: http() }),
    } as unknown as Gondi;

    expect(
      () => new OpenSeaMarket(gondi, new OpenSeaApi('key'), {} as unknown as GondiApi),
    ).toThrow('OpenSea bids run on mainnet only');
  });
});
