import { describe, expect, test } from 'bun:test';
import type { Gondi } from 'gondi';
import {
  type Address,
  createWalletClient,
  decodeFunctionData,
  type Hash,
  type Hex,
  http,
  parseAbi,
  zeroAddress,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import type { GondiApi } from '../src/gondi/api';
import { WETH } from '../src/gondi/market';
import { type OfferFulfillment, OpenSeaApi, SEAPORT_PROTOCOL } from '../src/opensea/api';
import {
  bestExitOffer,
  fulfillmentProceeds,
  OPENSEA_CONDUIT,
  OPENSEA_CONDUIT_KEY,
  OpenSeaMarket,
} from '../src/opensea/market';
import { eth } from './fakeMarket';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const BUYER: Address = '0x2400c5227e81603f4166c30b10b7779f6054a2aa';
const PUDGY: Address = '0xbd3531da5cf5857e7cfaa92426877b022e612cf8';
const OPENSEA_FEE: Address = '0x0000a26b00c1f0df003000390027140000faa719';
const SIGNED_ZONE: Address = '0x000056f7000000ece9003ca63978907a00ffd100';
const ORDER_HASH: Hash = '0xfb869d57bdf949b1725754b74449c75ece02e7e6b8f367e7d82efaaeec554623';
const NOW = new Date('2026-11-13T15:00:00Z');
const END_TIME = String(Math.floor(NOW.getTime() / 1_000) + 3_600);

/** A collection offer of `quantity` Pudgies for `total` WETH, paying OpenSea 1% of it. */
const offerJson = ({
  offerer = BUYER as Address,
  total = eth('4.48'),
  quantity = 2n,
  status = 'ACTIVE',
  remaining = 2,
  endTime = END_TIME,
  orderHash = ORDER_HASH as Hash,
} = {}) => ({
  order_hash: orderHash,
  protocol_data: {
    parameters: {
      offerer,
      offer: [
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: '0',
          startAmount: `${total}`,
          endAmount: `${total}`,
        },
      ],
      consideration: [
        {
          itemType: 4,
          token: PUDGY,
          identifierOrCriteria: '0',
          startAmount: `${quantity}`,
          endAmount: `${quantity}`,
          recipient: offerer,
        },
        {
          itemType: 1,
          token: WETH,
          identifierOrCriteria: '0',
          startAmount: `${total / 100n}`,
          endAmount: `${total / 100n}`,
          recipient: OPENSEA_FEE,
        },
      ],
      startTime: '1794349132',
      endTime,
      zone: SIGNED_ZONE,
    },
  },
  remaining_quantity: remaining,
  status,
  criteria: { collection: { slug: 'pudgypenguins' }, traits: null, numeric_traits: null },
});

/** What `offers/fulfillment_data` answers to sell Pudgy #6501 into `offerJson()`. */
const fulfillmentJson = ({
  functionName = 'fulfillAdvancedOrder',
  identifier = '6501',
  recipient = zeroAddress as Address,
  conduitKey = OPENSEA_CONDUIT_KEY as Hex,
  numerator = '1',
  offerer = BUYER as Address,
  side = 1,
  extraConsideration = [] as object[],
  withoutConsideration = false,
  rising = false,
} = {}) => {
  const order = offerJson({ offerer }).protocol_data.parameters;
  const [paid] = order.offer;
  const offer = {
    ...order,
    offer: [rising ? { ...paid, endAmount: `${eth('9')}` } : paid],
    consideration: withoutConsideration ? [] : [...order.consideration, ...extraConsideration],
  };
  return {
    protocol: 'seaport1.6',
    fulfillment_data: {
      transaction: {
        function: `${functionName}(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),uint120,uint120,bytes,bytes),(uint256,uint8,uint256,uint256,bytes32[])[],bytes32,address)`,
        chain: 1,
        to: SEAPORT_PROTOCOL,
        value: 0,
        input_data: {
          advancedOrder: {
            parameters: {
              ...offer,
              orderType: 3,
              zoneHash: zeroHash,
              salt: '12345',
              conduitKey: OPENSEA_CONDUIT_KEY,
              totalOriginalConsiderationItems: '2',
            },
            numerator,
            denominator: '2',
            signature: '0x1234',
            extraData: '0xabcd',
          },
          criteriaResolvers: [{ orderIndex: '0', side, index: '0', identifier, criteriaProof: [] }],
          fulfillerConduitKey: conduitKey,
          recipient,
        },
        calldata_suffix: '0x72db8c0b',
      },
      orders: [],
    },
  };
};

const fulfillmentOf = async (answer: object): Promise<OfferFulfillment> => {
  const api = new OpenSeaApi('key', (async () => Response.json(answer)) as unknown as typeof fetch);
  return api.offerFulfillment({
    orderHash: ORDER_HASH,
    fulfiller: account.address,
    contract: PUDGY,
    tokenId: 6501n,
  });
};

/** The offers as `OpenSeaApi.collectionOffers` parses them. */
const offersOf = (offers: object[]) =>
  new OpenSeaApi('key', (async () =>
    Response.json({ offers })) as unknown as typeof fetch).collectionOffers('pudgypenguins');

const SALE = { account: account.address, contract: PUDGY, tokenId: 6501n };

describe('bestExitOffer', () => {
  test('takes the offer that pays the seller most per item, fees out', async () => {
    const offers = await offersOf([
      offerJson({ total: eth('2.2'), quantity: 1n, orderHash: '0x01' }),
      offerJson({ total: eth('4.48'), quantity: 2n }),
    ]);

    expect(bestExitOffer(offers, account.address, NOW)).toEqual({
      id: ORDER_HASH,
      venue: 'opensea',
      netPrice: eth('2.2176'),
    });
  });

  test.each([
    ['the wallet’s own', { offerer: account.address }],
    ['an inactive one', { status: 'FILLED' }],
    ['a filled one', { remaining: 0 }],
    ['an expired one', { endTime: String(Math.floor(NOW.getTime() / 1_000)) }],
  ])('leaves out %s', async (_name, overrides) => {
    const offers = await offersOf([offerJson(overrides as never)]);
    expect(bestExitOffer(offers, account.address, NOW)).toBeNull();
  });
});

describe('fulfillmentProceeds', () => {
  test('pays one item’s share of the offer, its fee taken out', async () => {
    expect(fulfillmentProceeds(await fulfillmentOf(fulfillmentJson()), SALE)).toBe(eth('2.2176'));
  });

  test.each([
    ['another item', { identifier: '1' }, 'does not name item 6501'],
    ['a payment to someone else', { recipient: BUYER }, `it pays ${BUYER}`],
    ['more than one item', { numerator: '2' }, 'not of one item'],
    ['the wallet’s own offer', { offerer: account.address }, 'the wallet’s own'],
    [
      'a second item beside the one offered for',
      {
        extraConsideration: [
          {
            itemType: 2,
            token: PUDGY,
            identifierOrCriteria: '1234',
            startAmount: '1',
            endAmount: '1',
            recipient: BUYER,
          },
        ],
      },
      'more than the item and WETH fees',
    ],
    ['an amount that changes over time', { rising: true }, 'change over time'],
    ['a resolver on the offer side', { side: 0 }, 'does not name item 6501'],
    [
      'no item at all',
      { withoutConsideration: true },
      'does not ask for an item of the collection',
    ],
  ])('refuses a sale of %s', async (_name, overrides, reason) => {
    const fulfillment = await fulfillmentOf(fulfillmentJson(overrides as never));
    expect(() => fulfillmentProceeds(fulfillment, SALE)).toThrow(reason);
  });

  test('refuses a call it does not know', async () => {
    await expect(
      fulfillmentOf(fulfillmentJson({ functionName: 'matchAdvancedOrders' })),
    ).rejects.toThrow('OpenSea would sell through matchAdvancedOrders');
  });
});

const fulfillAbi = parseAbi([
  'struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }',
  'struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }',
  'struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }',
  'struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }',
  'struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }',
  'function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)',
]);

/** An `OpenSeaMarket` whose chain answers `gas` units at `gasPrice`, recording what it sends. */
const exitMarket = ({ approved = true, gas = 200_000n, gasPrice = 10n ** 9n } = {}) => {
  const sent: { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint }[] = [];
  const approvals: Address[] = [];
  const requests: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body && JSON.parse(init.body as string) });
    return Response.json(fulfillmentJson());
  }) as unknown as typeof fetch;
  const gondi = {
    account,
    wallet: {
      ...createWalletClient({ account, chain: mainnet, transport: http('http://localhost:1') }),
      sendTransaction: async (transaction: {
        to: Address;
        data: Hex;
        gas: bigint;
        maxFeePerGas: bigint;
      }) => {
        sent.push(transaction);
        return '0xhash';
      },
    },
    bcClient: {
      estimateGas: async () => gas,
      getGasPrice: async () => gasPrice,
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    },
    isApprovedNFTForAll: async ({ to }: { to: Address }) => {
      approvals.push(to);
      return approved;
    },
  } as unknown as Gondi;
  const gondiApi = {
    collectionMarket: async () => ({ contractAddress: PUDGY }),
  } as unknown as GondiApi;
  const market = new OpenSeaMarket(gondi, new OpenSeaApi('key', send), gondiApi, () => NOW);
  return { market, sent, approvals, requests };
};

const SELL = {
  scope: { slug: 'pudgypenguins', tokenId: 6501n },
  offer: { id: ORDER_HASH, venue: 'opensea' as const, netPrice: eth('2.2176') },
  minProceeds: eth('2.2'),
};

describe('OpenSeaMarket.sellToOffer', () => {
  test('sends the call OpenSea built, with its suffix, once its conduit is approved', async () => {
    const { market, sent, approvals, requests } = exitMarket();

    await market.sellToOffer(SELL);

    expect(requests[0].body).toEqual({
      offer: { hash: ORDER_HASH, chain: 'ethereum', protocol_address: SEAPORT_PROTOCOL },
      fulfiller: { address: account.address },
      units_to_fill: '1',
      consideration: { asset_contract_address: PUDGY, token_id: '6501' },
    });
    expect(approvals).toEqual([OPENSEA_CONDUIT]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(SEAPORT_PROTOCOL);
    expect(sent[0].gas).toBe(240_000n);
    expect(sent[0].maxFeePerGas).toBe(1_200_000_000n);
    expect(sent[0].data.endsWith('72db8c0b')).toBe(true);
    const { args } = decodeFunctionData({
      abi: fulfillAbi,
      data: sent[0].data.slice(0, -8) as Hex,
    });
    expect(args[1][0].identifier).toBe(6501n);
    expect(args[0].extraData).toBe('0xabcd');
  });

  test('sends nothing when the gas would take the sale under minProceeds', async () => {
    const { market, sent } = exitMarket({ gasPrice: 100n * 10n ** 9n });

    await expect(market.sellToOffer(SELL)).rejects.toThrow('after gas');
    expect(sent).toEqual([]);
  });

  test('sends nothing before the wallet approves the conduit', async () => {
    const { market, sent } = exitMarket({ approved: false });

    await expect(market.sellToOffer(SELL)).rejects.toThrow('approve-nft pudgypenguins opensea');
    expect(sent).toEqual([]);
  });
});
