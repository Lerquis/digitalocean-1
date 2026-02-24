const fetchMarketFromSlug = require("../utils/fetchMarketFromSlug");

const BTC_15M_WINDOW = 900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DataGetter {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("DataGetter");
    this.marketSlug = null;
    this.marketInfo = null;
  }

  async run() {
    while (true) {
      const market = await this.discoverMarket();

      const match = market.slug.match(/btc-updown-15m-(\d+)$/);
      const marketTs = parseInt(match[1]);
      const endsAtMs = (marketTs + BTC_15M_WINDOW) * 1000;
      const waitMs = endsAtMs - Date.now();

      if (waitMs > 0) {
        this.bus.emit("market:waiting", {
          slug: market.slug,
          endsAt: new Date(endsAtMs).toISOString(),
          waitSeconds: Math.round(waitMs / 1000),
        });
        this.log.info(
          `Market ends at ${new Date(endsAtMs).toISOString()} — waiting ${Math.round(waitMs / 1000)}s`
        );
        await sleep(waitMs);
      }

      this.bus.emit("market:expired", { slug: market.slug });
    }
  }

  async discoverMarket() {
    const discoveryStart = Date.now();
    const market = await this._findViaComputedSlugs();

    if (!market) {
      throw new Error("No active BTC 15m market found.");
    }

    this.marketSlug = market.slug;
    this.marketInfo = market;

    const totalMs = Date.now() - discoveryStart;
    this.log.info(`Market discovered in ${totalMs}ms — ${market.slug}`);

    this.bus.emit("market:discovered", this.marketInfo);
    return this.marketInfo;
  }

  async _findViaComputedSlugs() {
    const nowTs = Math.floor(Date.now() / 1000);

    for (let i = 0; i < 7; i++) {
      const ts = nowTs + i * BTC_15M_WINDOW;
      const tsRounded = Math.floor(ts / BTC_15M_WINDOW) * BTC_15M_WINDOW;
      const slug = `btc-updown-15m-${tsRounded}`;

      const t0 = Date.now();
      try {
        const market = await fetchMarketFromSlug(slug);
        const fetchMs = Date.now() - t0;

        if (nowTs < tsRounded + BTC_15M_WINDOW) {
          this.log.info(`Slug hit: ${slug} [fetch: ${fetchMs}ms]`);
          return market;
        }
      } catch (err) {
        const fetchMs = Date.now() - t0;
        this.log.warn(`Slug ${slug} failed [${fetchMs}ms]: ${err.message}`);
        continue;
      }
    }

    return null;
  }
}

module.exports = DataGetter;
