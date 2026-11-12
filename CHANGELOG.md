# Changelog

What changed in each release of GONDI Market Maker, newest first. A release's section is also its
notes on the GitHub Releases page.

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
