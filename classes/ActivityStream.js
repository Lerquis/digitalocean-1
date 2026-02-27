const WebSocket = require("ws");

const WS_URL = "wss://ws-live-data.polymarket.com/";
const PING_INTERVAL = 30000;

class ActivityStream {
  constructor(bus, logger) {
    this.bus = bus;
    this.log = logger.create("ActivityStream");
    this.ws = null;
    this.pingInterval = null;
    this.eventSlug = null;
    this.namesToTack = ["distinct-baguette"];

    // Latency tracking
    this.connectAt = null; // when new WebSocket() was called
    this.openAt = null; // when "open" fired
    this.lastMsgAt = null; // when the last message was received
    this.pingSentAt = null; // when the last ping was sent

    this.bus.on("market:discovered", (marketInfo) => {
      this.eventSlug = marketInfo.slug;
      this.log.info(`Connecting for slug: ${this.eventSlug}`);
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

      const subscriptionMessage = JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "activity",
            type: "*",
            filters: `{"event_slug":"${this.eventSlug}"}`,
          },
        ],
      });

      this.ws.send(subscriptionMessage);
      this.log.info(`Connected & subscribed [conn: ${connMs}ms]`);

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.pingSentAt = Date.now();
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, PING_INTERVAL);
    });

    this.ws.on("pong", () => {
      if (this.pingSentAt !== null) {
        const rttMs = Date.now() - this.pingSentAt;
        this.pingSentAt = null;
        this.log.info(`WS ping (pong) RTT: ${rttMs}ms`);
      }
    });

    this.ws.on("message", (data) => {
      const now = Date.now();

      let latencyTag;
      if (this.lastMsgAt === null) {
        latencyTag = `first-msg: +${now - this.openAt}ms`;
      } else {
        latencyTag = `+${now - this.lastMsgAt}ms`;
      }
      this.lastMsgAt = now;

      const raw = data.toString();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      // Record pong messages from custom logic
      if (parsed.type === "pong" && this.pingSentAt !== null) {
        const rttMs = Date.now() - this.pingSentAt;
        this.pingSentAt = null;
        this.log.info(`WS ping RTT: ${rttMs}ms`);
        return;
      }

      if (parsed.payload && parsed.payload.name.includes(this.namesToTack)) {
        this.log.info(`[WS Message] [${latencyTag}] ${raw}`);
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

module.exports = ActivityStream;
