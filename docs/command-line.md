# Command line guide

How to run the bot from the command line, what the tasks file holds, and how each strategy decides.

## Before you start

- Use a **dedicated wallet** holding only the WETH you are willing to have bid with. A filled bid
  is a real purchase.
- Let Seaport spend that WETH once (this one sends a transaction):

  ```bash
  MARKET_MAKER_PRIVATE_KEY=0x... bun start approve 3
  ```

## Run

```bash
bun install
cp tasks.example.json tasks.json   # edit it
MARKET_MAKER_PRIVATE_KEY=0x... bun start run tasks.json
```

A fork's own order book rarely holds realistic prices. Set `MARKET_MAKER_PRICE_API_URL` to another
lending GraphQL endpoint, such as production's `https://api2.gondi.xyz/lending/graphql`, and the bot
reads market prices from there: the floor, the best competing bid, the cheapest competing listing
and ETH's USD price. Its own bids, listings, holdings and sales still come from `GONDI_API_URL`, so
it trades on the fork at production's prices. Collections are matched by slug.

To test over more market than a run lasts, record a stretch of it and replay it faster:

```sh
MARKET_MAKER_PRICE_API_URL=https://api2.gondi.xyz/lending/graphql \
  bun start record-prices tasks.json history.json 7
MARKET_MAKER_PRICE_REPLAY_FILE=history.json bun start run tasks.json
```

`record-prices` samples each collection's floor every 15 minutes over the last 7 days. The API keeps
a top bid only per day, so each sample's best bid is its floor times that day's top bid over that
day's floor. The run then reads its prices from the file instead, on a clock 168 times faster than
the wall clock (`MARKET_MAKER_PRICE_REPLAY_SPEED`) that stood at the first sample when the file was
recorded, so a week plays in an hour and starts over. Every process replaying the file reads the
same moment. ETH's USD price stays at the recording's.

`Ctrl+C` cancels every bid the run placed before exiting. Listings stay live until they expire:
cancelling a listing costs a transaction, so the bot never does it (see Listings below).
`bun start cancel-all tasks.json` cancels the bids for a run that is no longer alive (it crashed, was
killed, or the machine slept). It does not stop a run that is still going, which bids again on its
next round: stop that one with `Ctrl+C`.

Set `MARKET_MAKER_RPC_URL` to your own Ethereum RPC endpoint for reliable balance reads. Instead of
`MARKET_MAKER_PRIVATE_KEY`, `MARKET_MAKER_PRIVATE_KEY_FILE` can name a file holding the key, such as
a mounted secret; set exactly one of them.

`SIGTERM` (what `docker stop` and process managers send) cancels the bids too, like `Ctrl+C`.

### Against a local fork

To try a strategy before it touches real funds, run the bot against a local fork of Ethereum (for
example Anvil's `anvil --fork-url <rpc>`) and a GONDI API serving that fork:

| Variable                | Points the bot at                                                                 |
| ----------------------- | --------------------------------------------------------------------------------- |
| `MARKET_MAKER_CHAIN_ID` | The fork's chain id (Anvil's default is `31337`). Unset, the bot runs on mainnet. |
| `MARKET_MAKER_RPC_URL`  | The fork's RPC endpoint; required with `MARKET_MAKER_CHAIN_ID`.                   |
| `GONDI_URL`             | The API the `gondi` SDK signs in to and publishes and cancels orders through.     |
| `GONDI_API_URL`         | The lending GraphQL endpoint market data is read from (`<api>/lending/graphql`).  |

The `gondi` SDK knows one local chain id, `ANVIL_CHAIN_ID` (`31337` unless set), and reads that
chain's GONDI contract addresses from `GONDI_*` variables (see the SDK). WETH, Seaport and its
conduits keep their mainnet addresses on a mainnet fork.

```bash
MARKET_MAKER_CHAIN_ID=31337 MARKET_MAKER_RPC_URL=http://localhost:8545 \
GONDI_URL=http://localhost:4000 GONDI_API_URL=http://localhost:4000/lending/graphql \
MARKET_MAKER_PRIVATE_KEY=0x... bun start run tasks.json
```

## Tasks file

| Field                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exposureLimit`                  | The most, in ETH, all live bids may commit together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pollSeconds`                    | How often every task is re-checked (at least 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lossLimits`                     | `{ "dailyUsd", "weeklyUsd", "since" }`: stop bidding once the loss reaches either cap (optional; see "Loss limits" below).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `wrapEth`                        | `{ "keepEth": "0.05" }`: wrap ETH into WETH when the bids are short of it, keeping that much ETH for gas (optional; see "Wrapping ETH" below).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tasks[].enabled`                | `false` keeps the task in the file without running it: it places nothing, and bids it left stay up until they expire or are cancelled (default `true`).                                                                                                                                                                                                                                                                                                                                                                                          |
| `tasks[].kind`                   | `collectionBid` (a bid any item of the collection can fill) or `listing` (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tasks[].venue`                  | `collectionBid` only: `gondi` (the default) or `opensea` (see "OpenSea bids" below).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tasks[].collection`             | The collection's slug, as in its GONDI or OpenSea URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tasks[].tokenId`                | `listing` only: the item's token id, as a string; leave it out to list every item of the collection the wallet holds.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tasks[].pricing`                | `{ "mode": "fixed", "price": "1.5" }`, `{ "mode": "floor", "percent": 90 }`, `{ "mode": "floor", "steps": 1 }` (that many price steps under the floor: 1 is the highest bid still below the cheapest listing), `{ "mode": "outbid", "steps": 1 }` (best competing collection bid plus that many price steps), or `{ "mode": "outbid", "percent": 0.5 }` (that bid plus 0.5%, rounded up onto the price step and at least one step above it); or `{ "mode": "level", "level": 5 }` (the fifth highest competing price, see "OpenSea bids" below). |
| `tasks[].minPrice` / `maxPrice`  | Hard limits in ETH; the bid never leaves them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tasks[].quantity`               | How many items the bid may buy (default 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tasks[].expirationMinutes`      | Bid lifetime; refreshed before it ends (default 60, at least 15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tasks[].haltOnFloorMovePercent` | Stop the task when the floor moves this much from where it started.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tasks[].maxFloorPercent`        | Never bid above this share of the floor, and do not bid without a floor (optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tasks[].maxItems`               | Keep bidding after a fill while the wallet holds fewer than this many items of the collection (optional).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tasks[].maxHeldValue`           | Keep bidding after a fill while the items held, valued at the floor, plus the live bid stay within this many ETH (optional).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tasks[].ladder`                 | `collectionBid` only: `{ "offers": 5, "spacing": "0.02" }` keeps that many offers live, the others on the multiples of `spacing` ETH below the top one (optional, at most 10; see "Ladders" below).                                                                                                                                                                                                                                                                                                                                              |

Without `maxItems`, a task stops for good once its bids have bought `quantity` items; a partly
filled bid keeps bidding for what it has left. With `maxItems`, a fill does not stop it: the task
withdraws its bid while the wallet holds `maxItems` items of the collection (`maxItemsHeld`) and bids
again when one leaves, for example when a listing sells. `maxHeldValue` works the same way by value:
the bid buys only as many items as fit under the cap beside what the wallet holds at the floor, and
is withdrawn (`maxHeldValue`) while not even one does. With both set, the tighter one wins. It
pauses, withdrawing its bid, while its price cannot be backed by the wallet's balance, Seaport
allowance or the exposure limit, and resumes when it can.

### Ladders

A bid task keeps one offer. With `ladder`, it keeps `offers` of them, to show the wallet at several
price levels of the book:

```json
"ladder": { "offers": 4, "spacing": "0.02" }
```

The top offer sits at the price `pricing` sets, as without a ladder. The others sit on the next
multiples of `spacing` below it, rounded down onto the marketplace's price step, and none goes under
`minPrice`: a top of 2.013 with that ladder bids 2.013, 2.00, 1.98 and 1.96. Since the lower offers
stay on the same multiples while the top moves within one spacing, such a move replaces only the top
offer. Each offer buys what the task still wants (`quantity`, after `maxItems` and `maxHeldValue`).

The offers share the top offer's WETH: the balance, allowance and `exposureLimit` checks count the
task as its top offer alone. That is what lets a ladder sit in a book on the WETH of one bid, and it
has a cost: several offers can fill within one round, before the next one counts what the wallet
holds, so a ladder can buy up to `offers` × `quantity` items before `quantity`, `maxItems` or
`maxHeldValue` stops it. Each fill spends WETH, so an offer the balance no longer covers simply fails
to fill.

### Loss limits

`lossLimits` stops every bid task by itself once the wallet has lost too much:

```json
"lossLimits": { "dailyUsd": 3000, "weeklyUsd": 10000, "since": "2026-11-04T00:00:00Z" }
```

Each round, before the bids, the bot measures its loss from the wallet's sales history on the
public API, with nothing stored locally, so a restart neither forgets it nor counts it twice:

- **Realized:** each sale in the window, net of the collection's required royalties and GONDI's sale
  fee, minus what the wallet paid for that item when it last bought it.
- **Unrealized:** each item it bought and still holds, valued at today's floor net of the same
  royalties and fee, minus what it paid. A held item only ever adds loss: one worth more than it
  cost counts as zero, since the floor may be the bot's own listing.
  It counts in both windows, so an item held underwater keeps the bot from bidding until it sells
  or the floor recovers.

The windows are the UTC day and the ISO week (from Monday 00:00 UTC), and the total is converted to
USD at the current ETH price. `since` starts the ledger: trades before it never count, and neither
does the sale of an item bought before it. Once either loss reaches its cap, every bid task
withdraws its bids and waits (`lossLimit`) while listings keep running; bidding resumes when the
window rolls over and the loss is back under both caps. When the sales, a floor or the ETH price
cannot be read, the bot stops bidding the same way rather than bid blind, unless a round measured
the loss within the last two minutes: it then keeps bidding on that loss and logs that the read
failed, so a dropped connection does not withdraw every bid. The loss is logged every round. The first round reads the sales since `since` in full, later ones only from an hour before the
latest sale already read, so only a restart pays for a `since` far in the past.

### Wrapping ETH

A listing sells for ETH, but bids spend WETH, so after a sale the bids can be left short of WETH.
`wrapEth` lets the bot wrap the ETH back by itself:

```json
"wrapEth": { "keepEth": "0.05" }
```

Each round, after the loss and before the bids, the bot reads the wallet's ETH and WETH. When the
WETH is under `exposureLimit`, it wraps the ETH over `keepEth` (up to what reaches `exposureLimit`)
and waits for that transaction to be mined, so the round's bids already see the WETH. A wrap under
0.01 ETH is skipped, as its gas would cost more than it adds. Each wrap, and each one that fails, is
logged; a failed wrap leaves the bids waiting on the WETH they lack until a later round wraps.
While the wallet has a transaction sent but not yet mined, such as a wrap that timed out, no round
wraps again, so a slow wrap is never doubled. The desktop app ignores `wrapEth`.

This is the one transaction the bot sends on its own, and only with `wrapEth` in the file. Without
it, wrap by hand (this sends a transaction):

```bash
MARKET_MAKER_PRIVATE_KEY=0x... bun start wrap 1.5
```

## Listings

A `listing` task sells one ERC-721 item for ETH:

```json
{
  "id": "pudgy-3950",
  "kind": "listing",
  "collection": "pudgypenguins",
  "tokenId": "3950",
  "pricing": { "mode": "undercut", "amount": "0.01" },
  "minPrice": "2.2",
  "maxPrice": "3",
  "expirationMinutes": 5
}
```

| Field                   | Meaning                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenId`               | The item to sell, which the bot wallet must hold. Leave it out to list every item of the collection the wallet holds (below).                                                                                                                                     |
| `pricing`               | `{ "mode": "fixed", "price": "2.5" }`, `{ "mode": "floor", "percent": 105 }` (a share of the cheapest other listing in the collection), or `{ "mode": "undercut", "amount": "0.01" }` (that listing minus that many ETH; `maxPrice` when nothing else is listed). |
| `minPrice` / `maxPrice` | Hard limits in ETH; the item is never listed outside them. `minPrice` must be above 0.                                                                                                                                                                            |
| `expirationMinutes`     | Listing lifetime; listed again before it ends (default and minimum 5).                                                                                                                                                                                            |

Let Seaport move the collection's items once (this one sends a transaction). For a collection
whose transfers are restricted to an approved operator (ERC721-C), this approves the Seaport
conduit GONDI lists it through instead:

```bash
MARKET_MAKER_PRIVATE_KEY=0x... bun start approve-nft pudgypenguins
```

In the desktop app, pick the collection in Settings' collection approval card instead; it asks
nothing when the collection is already approved.

A listing can only be cancelled on-chain, so the bot never cancels one. To go lower it lists again at
the new price and lets the older, dearer listing expire: a buyer takes the cheapest. It never goes
higher on its own: while a cheaper listing of yours is live, the task waits (`needsOnChainCancel`)
until that listing expires or you cancel it. Keep `expirationMinutes` short so that wait stays short.
Required collection royalties are added to the listing as fees. The task stops for good when the
item sells, and waits while the wallet does not hold the item or Seaport is not approved.

### Listing everything the wallet holds

Without `tokenId`, the task lists every item of the collection the wallet holds, each on its own and
by the same rules. It never stops: a sold item drops out, and an item the wallet receives (bought by
a bid task, or by hand) is listed from the round GONDI has indexed it, usually within a minute. One
`approve-nft` covers every item of the collection.

Next to a bid task with `maxItems`, this makes the bot a market maker: the bid buys up to `maxItems`
items, the listing sells them, and the bid buys again as they sell.

```json
[
  {
    "id": "pudgy-buy",
    "kind": "collectionBid",
    "collection": "pudgypenguins",
    "pricing": { "mode": "outbid", "steps": 1 },
    "minPrice": "2",
    "maxPrice": "2.3",
    "maxItems": 2
  },
  {
    "id": "pudgy-sell",
    "kind": "listing",
    "collection": "pudgypenguins",
    "pricing": { "mode": "undercut", "amount": "0.01" },
    "minPrice": "2.5",
    "maxPrice": "3"
  }
]
```

The bid never pays more than its `maxPrice` and the listing never sells under its `minPrice`, so each
round trip keeps at least the difference, less royalties and fees. The bot warns at start when a
listing's `minPrice` is not above the `maxPrice` of a bid on the same collection.

### Backtest fills

`backtest` fills the bot's listing from a recorded sale that took a listing at or above its price.
Its `strict` fills count a buyer within 2% of the floor as one who would have taken the bot's
listing, the cheapest; `loose` counts one within 10%. A listing under the floor reaches as much
further as it sits under it, for the floor sweepers it draws: 8% under the floor, `strict` counts
a buyer up to 10% over it.

## OpenSea bids

A collection bid can be posted on OpenSea instead, as a WETH collection offer, for example to keep
the bot's name in OpenSea's offer list without leading it:

```json
{
  "id": "bayc-opensea",
  "kind": "collectionBid",
  "venue": "opensea",
  "collection": "boredapeyachtclub",
  "pricing": { "mode": "level", "level": 5 },
  "minPrice": "4",
  "maxPrice": "5.5",
  "maxItems": 1,
  "expirationMinutes": 30
}
```

`{ "mode": "level", "level": 5 }` bids the fifth highest price anyone else offers on OpenSea, one
level per distinct price, so four better prices sit above it; it waits (`noPrice`) while fewer than
five exist. It is still a real offer that fills if the levels above it are taken or withdrawn before
the next round reprices it, so it counts against `exposureLimit` like any bid. OpenSea refuses an
offer the wallet's WETH does not cover. The other bid pricing modes work on OpenSea too, against its
best offer, with 0.01 WETH as the price step: OpenSea refuses an offer off that grid, so a bid
price is rounded down onto it.

GONDI bids take `level` too. There the levels come from GONDI's collection bid book, which also
lists the OpenSea offers GONDI indexes, each at its price on the collection's price step; the bot
reads it 20 bids at a time until it holds that many distinct prices, and at most 500 bids, so a
level deeper than those hold waits (`noPrice`) rather than bid higher.

It needs:

- An OpenSea API key (https://docs.opensea.io/reference/api-keys): `OPENSEA_API_KEY` in the
  environment of the command line, or saved in the desktop app's OpenSea API key card. Without it
  OpenSea tasks fail each round and the rest run on. A round reads OpenSea twice per OpenSea task,
  and a reprice posts once and cancels once, so keep `pollSeconds` within the key's rate limits.
- `maxItems`: once an offer fills, OpenSea stops listing it, so the bot cannot count its fills and
  stops buying only when the wallet holds `maxItems` items of the collection.
- OpenSea's conduit allowed to spend the WETH, since OpenSea offers pay through it, not through
  Seaport directly (this one sends a transaction):

  ```bash
  MARKET_MAKER_PRIVATE_KEY=0x... bun start approve-opensea 5
  ```

  or, in the desktop app, the WETH allowance card with OpenSea selected.

Offers are cancelled off-chain through OpenSea, with a signature and no transaction. OpenSea refuses
that for an offer under about five minutes old, so a task keeps a new offer up for its first five and
a half minutes, even at a stale price, rather than post another beside it, and a task that waits
withdraws it once that time is up. OpenSea bids run on mainnet only.

The name buyers see on the offers is the wallet's OpenSea profile. Set it on opensea.io, or from the
command line, which signs in to opensea.io as the wallet (accepting OpenSea's terms, as signing in
on the site does) and claims the username; the display name, the username unless given, takes
letters, digits, `_` and `-`:

```bash
MARKET_MAKER_PRIVATE_KEY=0x... bun start opensea-profile <username> [display-name]
```

OpenSea has no public API for profiles, so this replays the calls opensea.io makes and may break
when the site changes. A wallet keeps the first username it claims; running it again only changes
the display name.

## A crossed book

The bot posts nothing from a book where the floor or the cheapest other ask sits under the best
competing bid. No real seller stays listed there, since anyone would buy and sell straight into the
bid, so it is bad data, such as a dust listing: prod's history once read BAYC's floor at 6e-18 ETH.
Priced from it, a listing would go out at `minPrice` and a bid's caps would value held items at
nothing.

While the book is crossed, a listing task places and refreshes nothing (a live listing stays until
it expires, as the bot never cancels one), and a bid task withdraws its bid. Both wait with the
reason `crossedBook`, which the round log and the desktop app's strategy states show: a book that
stays crossed needs a look. An ask equal to the
bid is not crossed, and without a best bid there is nothing to check against. A crossed floor is
not a floor move either: `haltOnFloorMovePercent` neither halts on it nor measures from it.

## How it decides

Each round, every task reads one snapshot of its market (floor, best competing bid, its own bids,
balance and allowance) and makes one decision from it: keep its bids, place the missing ones and cancel
the rest, pause, or stop. The decision is a pure function (`src/engine/reconcile.ts` for bids,
`src/engine/listing.ts` for listings), so every rule is covered by tests that need no network.
