# Changelog

What changed in each release of GONDI Market Maker, newest first. A release's section is also its
notes on the GitHub Releases page.

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
