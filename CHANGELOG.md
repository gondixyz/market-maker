# Changelog

What changed in each release of GONDI Market Maker, newest first. A release's section is also its
notes on the GitHub Releases page.

# 0.3.0

- **Trait bids**: bid on the items of a collection that have one trait, such as `Background: Blue`,
  on GONDI. The strategy editor has a searchable trait and value picker and shows the trait's floor
  and top bid.
- **One budget for a GONDI and an OpenSea bid**: two bids on the same collection, one on each
  marketplace, now share the same WETH and count once against the exposure limit.
- **Lower a listing's price over time**: a listing can drop its price by a percent you pick every
  few hours while it goes unsold, never below its minimum price, with the new "Lower the price by"
  fields in the listing editor (`decay` in the tasks file).
- **Update notice**: when a newer release is out, an **Update to vX.Y.Z** button next to the
  version opens its download page.
- **Anonymous usage statistics**: the app sends a few anonymous events (app opened, wallet
  imported, bot started and stopped) so we can see how it is used. Nothing is sent until you click
  OK on the first-run notice, and one switch in Settings turns it off. The README lists exactly
  what is sent.
- **List on OpenSea too** (command line): with `openSeaListing` on an inventory listing, the bot
  also lists its items on OpenSea at a markup above its GONDI price.
- **Sell into bids** (command line): with `bidExit`, the bot sells a held item into the best GONDI
  or OpenSea bid at a profit, or at a capped loss once it can no longer bid on that collection.
- **Resale bids** (command line): with `resaleBid`, a collection bid that reached its item, value
  or exposure cap keeps one offer up at a price it can resell into the best other bid at a profit,
  within its own `resaleLimit`.
- **Loan offers on listed items** (command line): with `loanOffer`, an inventory listing also
  offers a short GONDI loan against each listed item, so a buyer can buy it with buy now, pay
  later. `approve-loans` approves the WETH those loans lend.
- **Swap USDC** (command line): `swap-usdc` swaps the wallet's USDC into WETH on Uniswap.
- Each round reads the wallet's own bids faster, so a round with many bids finishes sooner.
- Bid ladders keep their second offer a full spacing below the top one.
- The command line's `approve-nft` no longer sends a transaction when the collection is already
  approved, and a tasks file with `wrapEth` `keepEth` of `0` is refused instead of failing every
  wrap.
- Fixed: a listing or bid could expire between two rounds when the poll interval was long.
- Fixed: the pricing picker opened its list in the wrong place on Linux.

# 0.2.1

- **One-click downloads**: the README has a download button for each platform that always gets the
  latest installer. The installer files no longer carry the version in their names, such as
  `gondi-market-maker-mac-arm64.dmg`.

# 0.2.0

- **Breaking: undercut listings by an amount in ETH.** A listing in undercut mode now goes under the
  cheapest other listing by an amount you pick, such as `0.0001`, instead of by price steps. A saved
  strategy that still counts steps no longer loads until you give it an amount.
- **Bid ladders**: a collection bid can keep several offers at once, spaced below the top one, with
  `ladder` in the tasks file.
- **Wrap ETH into WETH**: with `wrapEth` in the tasks file, the bot wraps the ETH your sales bring
  in so the bids keep having WETH to bid with.
- **Approve from Settings**: see the current WETH allowance, approve an unlimited amount in one
  step, and approve a collection for listing, with a spinner until each approval is confirmed.
- **Clearer strategy editor**: info tooltips on the fields whose label does not say what they do, a
  warning when one price step is a large share of the floor, and the price step and marketplace of
  each strategy shown. "Count fills from" is now "Track losses since".
- **Getting started**: until a wallet key is imported, the window shows only the key card.
- **Running banner**: the strip under the header shows only while the bot runs, with a pulsing dot.
- Listings now expire after 5 minutes by default, so a moving floor no longer piles up live
  listings on one item.
- Fixed: a listing could go out at 0 ETH when one price step was larger than the floor.
- Fixed: OpenSea offers are rounded down onto OpenSea's 0.01 WETH grid instead of being refused.
- Fixed: expired listings no longer count as live, which could leave a listing strategy waiting
  forever.
- Fixed: a card showing a transaction hash no longer overflows its column.

# 0.1.0

The first public release.

- **Collection bids** on GONDI, or on OpenSea as collection offers with your own OpenSea API key.
  Each bid is kept competitive, refreshed before it expires and withdrawn off-chain, at no gas.
- **Bid pricing**: a fixed price, a share of the floor, a number of price steps under the floor,
  outbidding the best competing bid by steps or by a percentage, or joining the N-th competing
  price level.
- **Listings** of one item, or of every item of a collection the wallet holds, kept against the
  cheapest other listing.
- **Limits**: an exposure limit across every live bid, minimum and maximum prices, items or value
  held, a cap on the share of the floor, halting when the floor moves, and daily and weekly loss
  limits.
- **Desktop app** for macOS and Windows: import the bot wallet's key, encrypted by your operating
  system; edit, enable and save strategies; start, stop, cancel every bid or every listing; set
  your OpenSea API key and the WETH allowances in Settings.
- **Command line**: `run`, `cancel-all`, `approve` and `backtest`, with Prometheus metrics.
