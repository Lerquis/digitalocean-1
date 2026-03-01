class VirtualOrderManager {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("VirtualOrderManager");

    // Orders state
    this.activeOrders = {
      yes: null,
      no: null,
    };

    // Simulated network latencies
    this.msMin = 0;
    this.msMax = 0;

    // We hardcode order size for now
    this.defaultOrderSize = 10;

    // Listen to MarketMaker emitting new quotes
    this.bus.on("marketmaker:quotes", (data) => {
      this.handleNewQuotes(data.assetId, data.assetSide, data.type, data.price);
    });

    // Listen to market ticks to simulate fills
    this.bus.on("market:price_change", (changes) => {
      this.simulateFills(changes);
    });

    // Reset when market expires
    this.bus.on("market:expired", () => {
      this.cancelAllOrders();
    });
  }

  // Generate random delay
  getSimulatedDelay() {
    return (
      Math.floor(Math.random() * (this.msMax - this.msMin + 1)) + this.msMin
    );
  }

  handleNewQuotes(assetId, assetSide, type, price) {
    // If quote hasn't really changed or is missing, skip
    if (price === undefined) return;

    // Check if we already have an active order on this side (and type, e.g. "yes-BID" and "yes-ASK")
    // Note: User says "We could have a YES and NO order at the same time, but never 2 YES or 2 NO".
    // This implies we can only hold ONE active order per token side, regardless if it's bid or ask.
    // E.g. We will only have either a BID on YES or an ASK on YES active at any one time.
    // Check if we already have an active order on this side
    const existingOrder = this.activeOrders[assetSide];

    // If we have an existing order on the same side and same price, ignore it
    // Note: We use Math.abs to check for floating point equality within a tiny margin
    if (
      existingOrder &&
      Math.abs(existingOrder.price - price) < 0.0001 &&
      existingOrder.type === type
    ) {
      return;
    }

    const delay = this.getSimulatedDelay();

    // Cancel existing one on this side
    if (existingOrder) {
      clearTimeout(existingOrder.timerId); // Cancel impending actions if any
    }

    // Schedule new order placement
    const timerId = setTimeout(() => {
      this.activeOrders[assetSide] = {
        assetId: assetId,
        side: assetSide,
        type: type,
        price: price,
        size: this.defaultOrderSize,
        createdAt: Date.now(),
      };

      this.log.info(
        `[VOM] Placed Limit Order | Token: ${assetSide.toUpperCase()} | Type: ${type} | Price: ${price.toFixed(4)} | Size: ${this.defaultOrderSize} | Delay: ${delay}ms`,
      );
      // Removed log spam: this._logState();
    }, delay);

    // Keep reference to timerId so we can cancel it if another quote comes in before execution
    if (existingOrder) {
      this.activeOrders[assetSide] = { ...existingOrder, timerId };
    } else {
      this.activeOrders[assetSide] = { timerId }; // placeholder until placed
    }
  }

  simulateFills(changes) {
    // Iterate through market changes
    for (const change of changes) {
      for (const side of ["yes", "no"]) {
        const order = this.activeOrders[side];

        // Ensure order is actually active and belongs to this asset
        if (!order || !order.price || order.assetId !== change.asset_id)
          continue;

        let filled = false;

        // Wait, market changes might come separated inside "changes".
        // Polymarket sends bids/asks inside the tick. But we receive them inside MarketStream as 'book' vs 'price_change'.
        // If we are listening to price_change, we need to inspect them.

        // Wait, MarketStream's 'market:price_change' payload looks like:
        // [ { asset_id: "...", price: "0.20", size: "123.00", side: "SELL" }, ... ]
        // A FILL happens when... wait.
        // If our order is BID (we want to buy), we get filled when someone SELLS (side === "SELL") at a price <= our bid.
        // If our order is ASK (we want to sell), we get filled when someone BUYS (side === "BUY") at a price >= our ask.

        // Wait... price_change represents trades or order book updates?
        // Ah, it's usually trades! If side === "BUY", it means a market buy executed.
        // Let's assume price_change comes as an array of trades.

        if (order.type === "BID") {
          if (
            change.best_ask !== undefined &&
            parseFloat(change.best_ask) <= order.price
          ) {
            filled = true;
          }
        }

        if (filled) {
          const delay = this.getSimulatedDelay();
          setTimeout(() => {
            // In case order was updated while waiting for delay
            if (
              this.activeOrders[side] &&
              this.activeOrders[side].createdAt === order.createdAt
            ) {
              this.bus.emit("order:filled", {
                assetId: order.assetId,
                assetSide: side, // 'yes' or 'no' token
                orderType: order.type, // 'BID' or 'ASK'
                price: order.price,
                size: order.size,
              });

              this.log.info(
                `[VOM] Order FILLED! | Token: ${side.toUpperCase()} | Type: ${order.type} | Price: ${order.price.toFixed(4)} | Size: ${order.size} | Fill Delay: ${delay}ms`,
              );

              this.activeOrders[side] = null;
              this._logState();
            }
          }, delay);
        }
      }
    }
  }

  cancelAllOrders() {
    for (const side of ["yes", "no"]) {
      if (this.activeOrders[side]) {
        clearTimeout(this.activeOrders[side].timerId);
      }
    }
    this.activeOrders = { yes: null, no: null };
  }

  _logState() {
    const yesO =
      this.activeOrders.yes && this.activeOrders.yes.price
        ? `BID @ ${this.activeOrders.yes.price.toFixed(4)}`
        : "None";
    const noO =
      this.activeOrders.no && this.activeOrders.no.price
        ? `BID @ ${this.activeOrders.no.price.toFixed(4)}`
        : "None";

    this.log.info(`[VOM State] Active BIDs => YES: [${yesO}] | NO: [${noO}]`);
  }
}

module.exports = VirtualOrderManager;
