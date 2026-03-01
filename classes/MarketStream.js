const WebSocket = require("ws");

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL = 30000;

class MarketStream {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("MarketStream");
    this.ws = null;
    this.pingInterval = null;
    // Pre-serialized subscription message — built once on market:discovered,
    // sent as a raw Buffer on every (re)connect. Saves ~1-2ms of JSON.stringify
    // overhead that would otherwise happen on the hot path (ws "open" handler).
    this.subscriptionBuffer = null;

    // Latency tracking
    this.connectAt = null; // when new WebSocket() was called
    this.openAt = null; // when "open" fired
    this.lastMsgAt = null; // when the last message was received
    this.pingSentAt = null; // when the last ping was sent

    this.bus.on("market:discovered", (marketInfo) => {
      const assetIds = [marketInfo.yes_token_id, marketInfo.no_token_id].filter(
        Boolean,
      );
      this.subscriptionBuffer = Buffer.from(
        JSON.stringify({ type: "market", assets_ids: assetIds }),
      );
      this.log.info(`Subscribing to assets: ${assetIds.join(", ")}`);
      this.connect();
    });

    this.bus.on("market:expired", () => {
      this.disconnect();
    });
  }

  connect() {
    this.disconnect();

    // Reset latency state for this new connection
    this.connectAt = Date.now();
    this.openAt = null;
    this.lastMsgAt = null;
    this.pingSentAt = null;

    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      const connMs = Date.now() - this.connectAt;
      this.openAt = Date.now();

      // Send pre-built Buffer — no serialization on the hot path
      this.ws.send(this.subscriptionBuffer);
      this.log.info(`Connected & subscribed [conn: ${connMs}ms]`);

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.pingSentAt = Date.now();
          this.ws.ping();
        }
      }, PING_INTERVAL);
    });

    // Ping round-trip time — measures actual network latency to Polymarket WS
    this.ws.on("pong", () => {
      if (this.pingSentAt !== null) {
        const rttMs = Date.now() - this.pingSentAt;
        this.pingSentAt = null;
        this.log.info(`WS ping RTT: ${rttMs}ms`);
      }
    });

    this.ws.on("message", (data) => {
      const now = Date.now();

      // Latency tag: first message shows time-since-open; subsequent show delta
      let latencyTag;
      if (this.lastMsgAt === null) {
        latencyTag = `first-msg: +${now - this.openAt}ms`;
      } else {
        latencyTag = `+${now - this.lastMsgAt}ms`;
      }
      this.lastMsgAt = now;

      const raw = data.toString();
      // console.log(`[WS] [${new Date(now).toISOString()}] [${latencyTag}] ${raw}`);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      if (parsed.event_type === "price_change" && parsed.price_changes) {
        const changes = parsed.price_changes.map((c) => ({
          ...c,
          timestamp: now,
        }));

        this.bus.emit("market:price_change", changes);
      }
      if (parsed.event_type === "book") {
        this.bus.emit("market:book", parsed);
      }
    });

    this.ws.on("error", (err) => {
      this.log.error("WebSocket error:", err.message);
    });

    this.ws.on("close", () => {
      this.log.info("Connection closed");
      this._clearPing();
    });
  }

  disconnect() {
    this._clearPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  _clearPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

module.exports = MarketStream;
