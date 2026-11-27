# GONDI Market Maker - Agent Guide

A non-custodial market-making bot for NFT bids and listings on GONDI, open source under MIT.

## Workflow

When this package is checked out as a subdirectory of a wider repository, the `AGENTS.md` one level
above it carries the development workflow, the Git and PR conventions, and the review flow; this
guide then covers only what is specific to the bot. Standalone, this guide is the whole of it.

## Commands

- Install: `bun install`
- Run: `bun start run <tasks.json>` (see `docs/command-line.md`)
- Lint: `bun run lint` (prettier check, eslint, `tsc --noEmit`)
- Test: `bun run test`
- Desktop: `bun run dev:desktop` (Electron with hot reload), `bun run build:desktop` (into `out/`),
  `bun run package:desktop` (the installable app, into `dist/`)
- Verify: `bun run verify` (lint then tests; what CI runs)

## Releases

This package is mirrored to the public https://github.com/gondixyz/market-maker, whose own
workflows (`.github/workflows/`, inert inside a wider repository) check every PR and release each
new version:

1. Bump `version` in `package.json` in a PR that adds its `# <version>` section to the top of
   `CHANGELOG.md`, and merge it. The section is written for the app's users: what they can now do
   or no longer hit, not how. A check fails a version bump without one.
2. Sync the mirror and merge its PR (the wider repository's guide says how). That push to `main`
   finds no `v<version>` tag, so `release.yml` runs `verify`, builds the macOS DMGs and the Windows
   installer on their own runners, and publishes them as the release `v<version>`, tagging the
   pushed commit, with the version's `CHANGELOG.md` section followed by
   `.github/release-notes.md` as its notes. A push that leaves the version alone releases nothing;
   a failed release is retried by re-running it, or with the workflow's manual dispatch.

The installers are ad-hoc signed (macOS) or unsigned (Windows), not notarized; the release notes
and the README's "Download" say how to open them.

## Layout

| Directory      | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/`  | Marketplace-agnostic: the tasks file schema (`task.ts`), pricing, the per-round `reconcile` (bids) and `decideListing` (listings) decisions, the loss the `lossLimits` caps measure (`pnl.ts`), the `Runner` that carries decisions out, and `VenueMarket`, which sends each bid call to the `BidVenue` of the venue its task names. Depends on the `Market` port only.                                                                                                                                                                                  |
| `src/gondi/`   | `GondiMarket`, the `Market` port: market reads through `GondiApi` (the public lending API, no sign-in), signing, publishing and cancelling through the `gondi` SDK. The only module that talks to GONDI.                                                                                                                                                                                                                                                                                                                                                 |
| `src/opensea/` | `OpenSeaMarket`, the `BidVenue` for tasks with `"venue": "opensea"`: reads, builds, posts and cancels collection offers through `OpenSeaApi` (OpenSea's REST API, with the operator's key: `OPENSEA_API_KEY` in the CLI, encrypted in a `SecretFile` in the desktop app) and signs them with the wallet itself; it is also the `ExitVenue` that sells held items into other wallets' OpenSea offers for a listing's `bidExit`; `setOpenSeaProfile` names the wallet on opensea.io through the site's own sign-in. The only module that talks to OpenSea. |
| `src/desktop/` | The Electron app: `main/` holds the key vault and runs the engine, `preload/` exposes the typed `DesktopApi` (`api.ts`) to the window, `renderer/` is the React window.                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/cli/`     | The command-line runner: reads the key from the environment and wires the rest together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tests/`       | `bun test` suites; `fakeMarket.ts` is the in-memory `Market` every engine test runs against.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Rules

- **The engine sends two kinds of transaction, and only when told to.** Automatic actions are
  limited to signing orders, cancelling bids off-chain, with the tasks file's `wrapEth`, wrapping
  ETH into WETH (`Market.wrapEth`), which a listing's ETH sale leaves the bids short of, and, with a
  listing's `bidExit`, selling a held item into another wallet's collection bid on GONDI or OpenSea,
  whichever pays more (`Market.sellToOffer`, decided by `decideExit`). Anything else that costs gas (approvals, on-chain cancels) is an explicit user
  command. `Market.cancelBids` throws rather than fall back to an on-chain cancel. The desktop app
  drops `wrapEth` and `bidExit` in `createRunner`.
- **A sale OpenSea builds is checked before it is signed.** `fulfillmentProceeds` refuses any
  `fulfillAdvancedOrder` that is not one item of the collection, for WETH from someone else, paid to
  the wallet, through Seaport with no ETH, asking nothing beyond WETH fees, at fixed amounts. Seaport
  pulls every consideration item from the wallet through conduits it has approved for its WETH and
  items, so an extra item would be given away. A sale into a GONDI bid sends the calldata GONDI's
  own API builds (`getSaleCalldata`, as the SDK's `sellNft` does) to Seaport instead of calling
  `sellNft`, which caps no gas. Either `sellToOffer` re-estimates its gas, caps the gas limit and
  fee, and sends nothing when those caps could take it under the decision's `minProceeds`.
- **GONDI listings are never cancelled by the bot.** They cancel only on-chain, so repricing down
  lists again and leaves the older listing to expire, and repricing up waits for the user
  (`needsOnChainCancel`). Listings never count against `exposureLimit`, which caps bids only. The
  OpenSea copies `openSeaListing` makes (`decideMirror`, the `MirrorVenue` port) are the
  exception: placed on OpenSea's SignedZone, they cancel off-chain, so the bot cancels them
  whenever the GONDI listing they follow moves or goes.
- **GONDI loan offers are never cancelled by the bot either.** A listing's `loanOffer`
  (`decideLoanOffer`, the `LoanVenue` port) keeps one single-loan offer against each listed item
  for buy now, pay later; it cancels only on-chain, so a reprice signs a new one and hides the old
  one from the API, off-chain, while its signature still lends until it expires. So the principal
  never exceeds the listing's `minPrice`, the least the item can leave the wallet for, or whoever
  got it from a `bidExit` sale could borrow more than they paid and default. Offers draw on the
  wallet's WETH but not on `exposureLimit`: a loan only starts as the item is bought from the
  wallet.
- **A crossed book posts nothing.** A floor or cheapest other ask under the best competing bid is
  bad data (a dust listing), so `decideListing` and `reconcile` wait on `crossedBook` rather than
  price from it. The check compares two reads of the same moment, so it needs no stored state.
- **The API is the source of truth.** Nothing about orders is stored locally; each round re-reads
  the wallet's own bids, so a restart adopts the bids a previous run left instead of duplicating
  them. Exceptions, all in memory only: a closed bid is terminal, so `GondiMarket` keeps the
  closed bids it has read for the rest of the run instead of paging through them every round; and
  OpenSea lists a new offer only seconds after accepting it, so `OpenSeaMarket` counts an offer
  (or a listing) it posted among the wallet's own until a read shows it, it is cancelled, or two minutes pass. The
  `Runner` also keeps, in memory, the items it sold into other bids (the holdings index trails a
  sale), each `bidExit`'s count of sales per UTC day, which a restart starts again, when it first found
  each listed item held, where a listing's `decay` starts, so a restart lists at full price again,
  each task's `reference` moving average, which a restart seeds again from GONDI's floor history, each
  collection's floor at the start of the loss windows, which a restart reads again, and which
  `openSeaListing` tasks may still have OpenSea listings to cancel, and which `loanOffer` tasks
  may still have loan offers to hide.
- **Decisions are pure.** New behavior goes into `reconcile` or `pricing` with a table-style test,
  and the runner only carries decisions out.
- **Amounts are `bigint` wei.** The tasks file takes ETH strings and parses them once, at load.
- **The `gondi` SDK comes from npm**, never a path into a sibling directory: this package must build
  on its own. Market reads go in `GondiApi`, parsed with zod where they enter; the SDK keeps
  everything that signs or needs a session on GONDI. That includes the order book and a
  collection's market, which the SDK also offers (`Gondi.orders`, `Gondi.collectionMarket`): the
  SDK signs in before every call, public reads included, and its shapes differ from the bot's
  (`floorPrice` as `{ amount, currency }` rather than `bigint` wei, newest-first `sortBy` by
  default), so the bot keeps its own sign-in-free copies. OpenSea orders are the exception:
  the SDK has no OpenSea offers, so `src/opensea/` signs them with the wallet and posts them with the
  operator's own key.
- **Never log or persist a private key.** The CLI reads it from `MARKET_MAKER_PRIVATE_KEY` (or the
  file `MARKET_MAKER_PRIVATE_KEY_FILE` names); the desktop app keeps it only in `KeyVault`,
  encrypted by `safeStorage`. Either way it goes to viem's local account and nowhere else. The
  desktop app's OpenSea API key and RPC URL (providers put their key in it) get the same
  treatment: encrypted at rest, read in main, never sent to the window, which sees only whether a
  key is saved and the URL's host.
- **The key lives in Electron main only.** The window gets display DTOs (`DesktopStatus`) and calls
  exactly the `DesktopApi` channels; nothing sent to it carries the key, and the preload exposes no
  generic IPC. Keep the window's `contextIsolation`, `sandbox`, CSP and navigation blocks.
- **Usage statistics go through `src/desktop/main/telemetry.ts` only.** Its `TelemetryEvent` union
  is the whole list of what the desktop app sends, and the README's "Usage statistics" table must
  match it. An event carries counts, flags and fixed categories, never an address, a collection, a
  price or a message: bids are public, so anything finer could tie an install to its wallet. The
  CLI sends none.
- **On-chain desktop actions are confirmed in main**, with a native dialog the page cannot answer
  for it.
- **The app's name stays `gondi-market-maker`.** Electron names the `userData` directory and the
  `safeStorage` secret (the macOS Keychain item `<name> Safe Storage`, the Linux secret store's key)
  after `package.json`'s `productName`, else its `name`, so setting `productName` there or renaming
  the package strands every saved key and strategy. The display name lives in
  `electron-builder.yml`'s `productName`, which names the bundle only.
- **Desktop-only packages are `devDependencies`.** Electron, React and Vite are bundled into `out/`
  at build time, so nothing the CLI runs depends on them.
- **Mainnet unless told otherwise.** `MARKET_MAKER_CHAIN_ID` selects a local fork; with no new
  variable set, the bot must keep targeting mainnet.
