class MarketMaker {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("MarketMaker");

    this.yesTokenId = null;
    this.noTokenId = null;

    this.inventory = {
      yes: { qty: 0, avg: 0 },
      no: { qty: 0, avg: 0 },
    };

    this.riskFactor = 0.05;
    this.spreadMargin = 0.01;

    // Hard Boundaries & Risk Parameters
    this.maxOrderSize = parseInt(process.env.MAX_ORDER_SIZE || "20");
    this.minOrderSize = parseInt(process.env.MIN_ORDER_SIZE || "5");
    this.baseRiskAllowance = parseFloat(
      process.env.BASE_RISK_ALLOWANCE || "10",
    );

    this.bus.on("market:discovered", (marketInfo) => {
      this.yesTokenId = marketInfo.yes_token_id;
      this.noTokenId = marketInfo.no_token_id;

      // Reset inventory on a new market
      this.inventory = {
        yes: { qty: 0, avg: 0 },
        no: { qty: 0, avg: 0 },
      };
    });

    this.bus.on("market:book", (bookEvent) => {
      this.handleBookEvent(bookEvent);
    });

    this.bus.on("order:filled", (fillEvent) => {
      this.handleOrderFill(fillEvent);
    });

    this.bus.on("market:expired", () => {
      this.handleMarketExpiration();
    });
  }

  handleMarketExpiration() {
    // Print theoretical metrics before purging
    const yesCost = this.inventory.yes.qty * this.inventory.yes.avg;
    const noCost = this.inventory.no.qty * this.inventory.no.avg;
    const totalInvested = yesCost + noCost;

    this.log.summary(`[MARKET EXPIRED] Position PnL Summary:`);
    this.log.summary(
      `   - Total YES: ${this.inventory.yes.qty.toFixed(2)} units (Cost Avg: $${this.inventory.yes.avg.toFixed(4)}) -> $${yesCost.toFixed(2)} invested.`,
    );
    this.log.summary(
      `   - Total NO: ${this.inventory.no.qty.toFixed(2)} units (Cost Avg: $${this.inventory.no.avg.toFixed(4)}) -> $${noCost.toFixed(2)} invested.`,
    );
    this.log.summary(
      `   => Theoretical Total Invested: $${totalInvested.toFixed(2)}`,
    );
    this.log.summary(
      `   => If winning side, payout: $${(Math.max(this.inventory.yes.qty, this.inventory.no.qty) * 1).toFixed(2)}`,
    );

    this.inventory = {
      yes: { qty: 0, avg: 0 },
      no: { qty: 0, avg: 0 },
    };
  }

  handleOrderFill(fillEvent) {
    const { assetSide, orderType, price, size } = fillEvent;

    const qty = parseFloat(size);
    const p = parseFloat(price);

    let inventoryRef = this.inventory[assetSide]; // yes or no

    // Calculate new average: (oldQty * oldAvg + newQty * newPrice) / (oldQty + newQty)
    // IMPORTANT: Wait, if we are BUYING, inventory increases. If SELLING, inventory decreases.
    // Assuming ASK means Selling our inventory, BID means Buying.

    if (orderType === "BID") {
      // Buying inventory
      const totalCost = inventoryRef.qty * inventoryRef.avg + qty * p;
      inventoryRef.qty += qty;
      inventoryRef.avg =
        inventoryRef.qty === 0 ? 0 : totalCost / inventoryRef.qty;
    }

    this.log.info(
      `[INV UPDATE] ${assetSide.toUpperCase()} Fill applied! New Inv => YES: [Qty: ${this.inventory.yes.qty.toFixed(2)} | Avg: ${this.inventory.yes.avg.toFixed(4)}] | NO: [Qty: ${this.inventory.no.qty.toFixed(2)} | Avg: ${this.inventory.no.avg.toFixed(4)}]`,
    );
  }

  handleBookEvent(bookEvent) {
    if (!this.yesTokenId || !this.noTokenId) return;

    // Only process for YES or NO tokens of the discovered market
    if (
      bookEvent.asset_id !== this.yesTokenId &&
      bookEvent.asset_id !== this.noTokenId
    ) {
      return;
    }

    const { bids, asks } = bookEvent;

    // Ensure we have at least one level to analyze
    if (!bids || !asks || bids.length === 0 || asks.length === 0) return;

    // The current level (top of the book)
    // For bids, polymarket gives an ascending array from '0.01' to '0.18' so the best bid is at the end.
    // For asks, polymarket gives a descending array from '0.99' to '0.20' so the best ask is at the end.
    const bestBidLevel = bids[bids.length - 1];
    const bestAskLevel = asks[asks.length - 1];

    const bestBidPrice = parseFloat(bestBidLevel.price);
    const bestBidSize = parseFloat(bestBidLevel.size);

    const bestAskPrice = parseFloat(bestAskLevel.price);
    const bestAskSize = parseFloat(bestAskLevel.size);

    // Spread = Best Ask - Best Bid
    const spread = bestAskPrice - bestBidPrice;

    // Mid Price = (Best Ask + Best Bid) / 2
    const midPrice = (bestAskPrice + bestBidPrice) / 2;

    // Micro Price
    // Formula: (Best Bid * Ask Size + Best Ask * Bid Size) / (Bid Size + Ask Size)
    // Helps estimate order flow pressure
    const microPrice =
      (bestBidPrice * bestAskSize + bestAskPrice * bestBidSize) /
      (bestBidSize + bestAskSize);

    const imbalancePct = this.getInventoryImbalance();
    const side = bookEvent.asset_id === this.yesTokenId ? "yes" : "no";

    const reservationPrice = this.getReservationPrice(
      microPrice,
      imbalancePct,
      side,
    );

    // Quote generation
    const quotes = this.getBidAskPrices(reservationPrice);

    // Dynamic Sizing (Risk Bounds Engine)
    const allowedSize = this.calculateDynamicSize(side, quotes.bid);

    // Let's emit to the virtual order manager
    // Pass the strictly calculated size limits instead of blindly relying on defaults
    this.bus.emit("marketmaker:quotes", {
      assetId: bookEvent.asset_id,
      assetSide: side,
      type: "BID",
      price: quotes.bid,
      size: allowedSize, // New injected logic
    });

    this.log.info(
      `[BOOK ${side.toUpperCase()}] Bid: ${bestBidPrice.toFixed(4)}... MMBid: ${quotes.bid.toFixed(4)} | Size Limit: ${allowedSize}`,
    );
  }

  /**
   * Returns the inventory imbalance as a percentage (-100% to +100%).
   * Positive (%) means excess YES relative to NO.
   * Negative (%) means excess NO relative to YES.
   * Example: 2600 NO and 2400 YES returns -4%
   */
  getInventoryImbalance() {
    const yesQty = this.inventory.yes.qty;
    const noQty = this.inventory.no.qty;
    const totalQty = yesQty + noQty;

    if (totalQty === 0) return 0;

    return ((yesQty - noQty) / totalQty) * 100;
  }

  /**
   * Calculates the maximum safe amount of shares to buy of a given token side
   * based on the opposite side's profit cushion, bounded by the API rules.
   */
  calculateDynamicSize(targetSide, bidPrice) {
    const totalInvested =
      this.inventory.yes.qty * this.inventory.yes.avg +
      this.inventory.no.qty * this.inventory.no.avg;

    const currentProfitYes = this.inventory.yes.qty - totalInvested;
    const currentProfitNo = this.inventory.no.qty - totalInvested;

    let theoreticalShares = 0;

    // If we want to buy YES, our cushion relies on the absolute worst-case scenario: NO wins.
    // So our allowance to buy YES is strictly bounded by (Profit_NO + Base_Risk_Allowance).
    if (targetSide === "yes") {
      const budgetUsd = currentProfitNo + this.baseRiskAllowance;
      theoreticalShares = budgetUsd / bidPrice;
    }
    // If we want to buy NO, we rely on the YES cushion.
    else if (targetSide === "no") {
      const budgetUsd = currentProfitYes + this.baseRiskAllowance;
      theoreticalShares = budgetUsd / bidPrice;
    }

    // Floor numbers so we don't attempt fractional shares
    let allowedSize = Math.floor(theoreticalShares);

    // Hard ceiling (Max Configured Size by User)
    allowedSize = Math.min(allowedSize, this.maxOrderSize);

    // Hard floor (Min Limit mandated by Polymarket API)
    if (allowedSize < this.minOrderSize) {
      allowedSize = 0; // The execution is paralyzed until the budget recovers
    }

    return allowedSize;
  }

  /**
   * Returns the Reservation Price (quote skewing impact).
   * It adjusts the micro price asymmetrically:
   *
   * imbalancePct is raw percentage (ex: +10 means 10% more YES than NO)
   *
   * If quoting YES:
   *   - Positive imbalance (too much YES) => subtracts from microPrice (we buy cheaper)
   *   - Negative imbalance (too much NO) => adds to microPrice (we buy more aggressively)
   *
   * If quoting NO:
   *   - Positive imbalance (too much YES) => adds to microPrice (we buy more aggressively)
   *   - Negative imbalance (too much NO)  => subtracts from microPrice (we buy cheaper)
   */
  getReservationPrice(microPrice, imbalancePct, targetSide) {
    const imbalanceDecimal = imbalancePct / 100;

    let adjustment = imbalanceDecimal * this.riskFactor;

    // If we're quoting NO, the math is inverted.
    // Example: imbalance = +10% (too much YES).
    // For YES side: adjustment is positive, so (microPrice - adjustment) Lowers our bid.
    // For NO side: we flip it, so (microPrice - (-adjustment)) Raises our bid.
    if (targetSide === "no") {
      adjustment = -adjustment;
    }

    return microPrice - adjustment;
  }

  /**
   * Generates Bid/Ask quotes using the Reservation Price and spreadMargin.
   */
  getBidAskPrices(reservationPrice) {
    let bidPrice = reservationPrice - this.spreadMargin;

    // Redondeo al centavo más cercano obligatoriamente para cumplir con API Polymarket
    bidPrice = Math.round(bidPrice * 100) / 100;

    // Clamp prices safely inside Polymarket bounds (0.01 - 0.99)
    bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));

    return { bid: bidPrice };
  }
}

module.exports = MarketMaker;
