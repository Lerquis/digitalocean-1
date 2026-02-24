/**
 * ArbitrageAnalyzer
 *
 * Listens to market:price_change events and checks for arbitrage in Polymarket
 * binary markets (BTC Up or Down).
 *
 * In a binary market, YES + NO tokens should sum to exactly $1.00 at settlement.
 * Arbitrage exists when:
 *   - BUY ARB:  ask(YES) + ask(NO) < 1.00  → buy both for less than $1 payout
 *   - SELL ARB: bid(YES) + bid(NO) > 1.00  → sell both for more than $1 cost
 *
 * Order book convention (Polymarket CLOB):
 *   side "BUY"  = bid  → price you receive when you sell
 *   side "SELL" = ask  → price you pay when you buy
 */

class OrderBook {
  constructor(tokenId) {
    this.tokenId = tokenId;
    this.bids = new Map(); // price (number) -> size (number)
    this.asks = new Map(); // price (number) -> size (number)
  }

  update(price, side, size) {
    const p = parseFloat(price);
    const s = parseFloat(size);
    const book = side === "BUY" ? this.bids : this.asks;

    if (s === 0) {
      book.delete(p);
    } else {
      book.set(p, s);
    }
  }

  /** Highest price a buyer is willing to pay (best bid). */
  getBestBid() {
    if (this.bids.size === 0) return null;
    return Math.max(...this.bids.keys());
  }

  /** Lowest price a seller is willing to accept (best ask). */
  getBestAsk() {
    if (this.asks.size === 0) return null;
    return Math.min(...this.asks.keys());
  }
}

class ArbitrageAnalyzer {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("ArbitrageAnalyzer");

    this.yesTokenId = null;
    this.noTokenId = null;
    this.books = {}; // tokenId -> OrderBook

    this.bus.on("market:discovered", (marketInfo) => {
      this._onMarketDiscovered(marketInfo);
    });

    this.bus.on("market:price_change", (changes) => {
      this._onPriceChange(changes);
    });
  }

  _onMarketDiscovered(marketInfo) {
    this.yesTokenId = marketInfo.yes_token_id;
    this.noTokenId = marketInfo.no_token_id;
    this.books = {};

    if (this.yesTokenId) {
      this.books[this.yesTokenId] = new OrderBook(this.yesTokenId);
    }
    if (this.noTokenId) {
      this.books[this.noTokenId] = new OrderBook(this.noTokenId);
    }

    this.log.info(
      `Tracking market: ${marketInfo.slug} | YES=${this.yesTokenId} | NO=${this.noTokenId}`,
    );
  }

  _onPriceChange(changes) {
    for (const change of changes) {
      const book = this.books[change.asset_id];
      if (!book) continue;
      book.update(change.price, change.side, change.size);
    }

    const ts = changes[0]?.timestamp ?? Date.now();
    this._checkArbitrage(ts);
  }

  _checkArbitrage(timestamp) {
    if (!this.yesTokenId || !this.noTokenId) return;

    const yesBook = this.books[this.yesTokenId];
    const noBook = this.books[this.noTokenId];

    if (!yesBook || !noBook) return;

    const yesBid = yesBook.getBestBid();
    const yesAsk = yesBook.getBestAsk();
    const noBid = noBook.getBestBid();
    const noAsk = noBook.getBestAsk();

    const isoTs = new Date(timestamp).toISOString();

    // ── BUY ARBITRAGE ────────────────────────────────────────────────────────
    // Buy YES at ask + Buy NO at ask < $1.00 → lock in risk-free profit
    if (yesAsk !== null && noAsk !== null) {
      const combinedAsk = yesAsk + noAsk;
      if (combinedAsk < 1.0) {
        const profitCents = ((1.0 - combinedAsk) * 100).toFixed(2);
        const profitPct = ((1.0 - combinedAsk) * 100).toFixed(2);

        console.log(
          `\n🟢 [ARB DETECTED — BUY BOTH] @ ${isoTs}` +
            `\n   YES ask : $${yesAsk.toFixed(4)}` +
            `\n   NO  ask : $${noAsk.toFixed(4)}` +
            `\n   Combined: $${combinedAsk.toFixed(4)} (< $1.00)` +
            `\n   Profit  : ${profitCents}¢ per $1 contract (${profitPct}%)\n`,
        );

        this.bus.emit("arbitrage:detected", {
          type: "BUY_BOTH",
          yesPrice: yesAsk,
          noPrice: noAsk,
          combined: combinedAsk,
          profit: 1.0 - combinedAsk,
          timestamp,
          detectedAt: isoTs,
        });
      }
    }

    // ── SELL ARBITRAGE ───────────────────────────────────────────────────────
    // Sell YES at bid + Sell NO at bid > $1.00 → lock in risk-free profit
    if (yesBid !== null && noBid !== null) {
      const combinedBid = yesBid + noBid;
      if (combinedBid > 1.0) {
        const profitCents = ((combinedBid - 1.0) * 100).toFixed(2);
        const profitPct = ((combinedBid - 1.0) * 100).toFixed(2);

        console.log(
          `\n🟢 [ARB DETECTED — SELL BOTH] @ ${isoTs}` +
            `\n   YES bid : $${yesBid.toFixed(4)}` +
            `\n   NO  bid : $${noBid.toFixed(4)}` +
            `\n   Combined: $${combinedBid.toFixed(4)} (> $1.00)` +
            `\n   Profit  : ${profitCents}¢ per $1 contract (${profitPct}%)\n`,
        );

        this.bus.emit("arbitrage:detected", {
          type: "SELL_BOTH",
          yesPrice: yesBid,
          noPrice: noBid,
          combined: combinedBid,
          profit: combinedBid - 1.0,
          timestamp,
          detectedAt: isoTs,
        });
      }
    }

    // ── SPREAD SUMMARY (always log current best prices) ──────────────────────
    // if (yesBid !== null || yesAsk !== null || noBid !== null || noAsk !== null) {
    //   const fmt = (v) => (v !== null ? `$${v.toFixed(4)}` : "   --  ");
    //   console.log(
    //     `[PRICES] ${new Date(timestamp).toISOString()}` +
    //       ` | YES bid=${fmt(yesBid)} ask=${fmt(yesAsk)}` +
    //       ` | NO  bid=${fmt(noBid)} ask=${fmt(noAsk)}` +
    //       ` | askSum=${yesAsk !== null && noAsk !== null ? (yesAsk + noAsk).toFixed(4) : "--"}` +
    //       ` | bidSum=${yesBid !== null && noBid !== null ? (yesBid + noBid).toFixed(4) : "--"}`
    //   );
    // }
  }
}

module.exports = ArbitrageAnalyzer;
