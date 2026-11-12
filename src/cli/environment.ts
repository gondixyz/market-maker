import { readFile } from 'node:fs/promises';

import { type Chain, defineChain, type Hex, isHex } from 'viem';
import { mainnet } from 'viem/chains';

import { GondiApi, type PriceApi } from '../gondi/api';
import { parsePriceHistory, PriceReplay } from '../gondi/replay';
import { OpenSeaApi } from '../opensea/api';

const DEFAULT_REPLAY_SPEED = 168;

type Environment = Record<string, string | undefined>;

/**
 * The chain the bot signs for, from `MARKET_MAKER_CHAIN_ID`: Ethereum mainnet when unset. Any other
 * id is a local fork of mainnet (WETH, Seaport and its conduits sit at their mainnet addresses), so
 * it takes mainnet's definition under that id and needs `MARKET_MAKER_RPC_URL`, since mainnet's
 * public endpoint would answer for the wrong chain.
 *
 * IMPLEMENTATION NOTE: the `gondi` SDK picks its contract addresses by `wallet.chain.id`. Besides
 * mainnet it knows one local chain, `ANVIL_CHAIN_ID` (31337 when unset), whose addresses it reads
 * from `GONDI_*` variables such as `GONDI_MULTI_SOURCE_LOAN_V8`; an id it does not know throws
 * `No contracts found for chain <id>` (`buildContractsByChain` in the SDK's `src/contracts.ts`,
 * https://github.com/gondixyz/gondi-js). `defineChain` is viem's way to declare a chain it does not
 * ship (https://viem.sh/docs/chains/introduction#custom-chains).
 */
export const chainFrom = (environment: Environment): Chain => {
  const configured = environment.MARKET_MAKER_CHAIN_ID;
  if (!configured) return mainnet;
  const id = Number(configured);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('MARKET_MAKER_CHAIN_ID must be a positive integer chain id');
  if (id === mainnet.id) return mainnet;
  if (!environment.MARKET_MAKER_RPC_URL)
    throw new Error(
      'MARKET_MAKER_RPC_URL must point at the fork when MARKET_MAKER_CHAIN_ID is set',
    );
  return defineChain({ ...mainnet, id, name: `Local fork (${id})` });
};

/**
 * The bot wallet's key, from exactly one of `MARKET_MAKER_PRIVATE_KEY` or
 * `MARKET_MAKER_PRIVATE_KEY_FILE` (a file holding the key, surrounding whitespace ignored, as a
 * mounted secret is).
 */
export const privateKeyFrom = async (environment: Environment): Promise<Hex> => {
  const { MARKET_MAKER_PRIVATE_KEY: inline, MARKET_MAKER_PRIVATE_KEY_FILE: path } = environment;
  if (Boolean(inline) === Boolean(path))
    throw new Error('set exactly one of MARKET_MAKER_PRIVATE_KEY or MARKET_MAKER_PRIVATE_KEY_FILE');
  const key = inline || (await readFile(path as string, 'utf8')).trim();
  if (!isHex(key)) throw new Error('the private key must be 0x-prefixed');
  return key;
};

/**
 * Where market prices are read, when not from the API everything else is read from: a recorded
 * history played back (`MARKET_MAKER_PRICE_REPLAY_FILE`, written by `record-prices`, at
 * `MARKET_MAKER_PRICE_REPLAY_SPEED` times the wall clock, 168 by default: a week an hour), or
 * another deployment's live API (`MARKET_MAKER_PRICE_API_URL`). `undefined` when neither is set.
 * A replay is refused on mainnet, where its stale prices would be filled with real funds.
 */
export const priceApiFrom = async (environment: Environment): Promise<PriceApi | undefined> => {
  const {
    MARKET_MAKER_PRICE_REPLAY_FILE: replayFile,
    MARKET_MAKER_PRICE_REPLAY_SPEED: configuredSpeed,
    MARKET_MAKER_PRICE_API_URL: apiUrl,
  } = environment;
  if (replayFile) {
    if (chainFrom(environment).id === mainnet.id)
      throw new Error(
        'MARKET_MAKER_PRICE_REPLAY_FILE runs only on a fork (MARKET_MAKER_CHAIN_ID): on mainnet it would trade real funds at recorded prices',
      );
    const speed = Number(configuredSpeed || DEFAULT_REPLAY_SPEED);
    if (!(speed > 0)) throw new Error('MARKET_MAKER_PRICE_REPLAY_SPEED must be a positive number');
    return new PriceReplay(parsePriceHistory(await readFile(replayFile, 'utf8')), speed);
  }
  return apiUrl ? new GondiApi(apiUrl) : undefined;
};

/**
 * OpenSea's API with the operator's key, `OPENSEA_API_KEY`, which tasks bidding on OpenSea need;
 * `undefined` when it is unset.
 */
export const openSeaApiFrom = (environment: Environment) =>
  environment.OPENSEA_API_KEY ? new OpenSeaApi(environment.OPENSEA_API_KEY) : undefined;
