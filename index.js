const EventBus = require("./classes/Bus");
const DataGetter = require("./classes/DataGetter");
const MarketStream = require("./classes/MarketStream");
const ArbitrageAnalyzer = require("./classes/ArbitrageAnalyzer");
const logger = require("./utils/logger");
const { preResolve } = require("./utils/dnsCache");

const log = logger.create("Main");

// Hosts that will be dialed during normal operation.
// Pre-resolving here warms the DNS cache so the first connection
// (HTTP fetch + WebSocket) skips the 1-2ms OS resolver round-trip.
const EXTERNAL_HOSTS = [
  "polymarket.com",
  "ws-subscriptions-clob.polymarket.com",
];

async function main() {
  log.info("Pre-resolving DNS...");
  await preResolve(...EXTERNAL_HOSTS);
  log.info(`DNS cached: ${EXTERNAL_HOSTS.join(", ")}`);

  const bus = new EventBus();

  // ── Wire up modules ────────────────────────────────────────────────────────
  new MarketStream(bus, logger);
  new ArbitrageAnalyzer(bus, logger);

  // ── Debug listeners ────────────────────────────────────────────────────────
  bus.on("market:discovered", (info) => {
    log.info(`Market discovered: ${info.slug}`);
  });

  bus.on("market:waiting", ({ slug, endsAt, waitSeconds }) => {
    log.info(`Waiting for market to expire: ${slug} | ends ${endsAt} (${waitSeconds}s)`);
  });

  bus.on("market:expired", ({ slug }) => {
    log.info(`Market expired: ${slug} — searching for next...`);
  });

  bus.on("arbitrage:detected", (arb) => {
    log.info(
      `Arbitrage event — type=${arb.type} profit=${(arb.profit * 100).toFixed(2)}¢ at=${arb.detectedAt}`
    );
  });

  // ── Start market discovery loop ────────────────────────────────────────────
  const dataGetter = new DataGetter(bus, logger);

  log.info("Bot started — scanning for BTC 15m markets...");
  await dataGetter.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
