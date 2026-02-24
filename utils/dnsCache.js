const { lookup: dnsLookup } = require("dns");

const TTL_MS = 5 * 60 * 1000; // re-resolve after 5 minutes
const cache = new Map(); // hostname -> { address, family, ts }

/**
 * Callback-compatible lookup that undici passes to the underlying TLS socket.
 * Serves from cache on hit; falls back to OS resolver on miss/expiry.
 * Signature matches what Node's net.connect / tls.connect expect for `lookup`.
 */
function lookup(hostname, options, callback) {
  const entry = cache.get(hostname);
  if (entry && Date.now() - entry.ts < TTL_MS) {
    return callback(null, entry.address, entry.family);
  }

  dnsLookup(hostname, { family: 4 }, (err, address, family) => {
    if (err) return callback(err);
    cache.set(hostname, { address, family, ts: Date.now() });
    callback(null, address, family);
  });
}

/**
 * Eagerly resolve and warm the cache at process startup.
 * Eliminates the 1-2ms DNS round-trip on the very first connection.
 */
async function preResolve(...hostnames) {
  const { lookup: asyncLookup } = require("dns").promises;
  await Promise.all(
    hostnames.map(async (hostname) => {
      const { address, family } = await asyncLookup(hostname, { family: 4 });
      cache.set(hostname, { address, family, ts: Date.now() });
    })
  );
}

module.exports = { lookup, preResolve };
