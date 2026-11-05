// Netcode Lab: the lab server and its clients in one process, over pretend links (net.js: latency, jitter, in order).
// The page uses it for the offline mode (no server needed); test.mjs drives it on a fake clock. Packets and server ticks
// run in time order; the caller runs each client's frame().
(function (NL) {
'use strict';
const { Net, LabServer } = NL;
const TICK_MS = LabServer.consts.TICK_MS;

class Harness {
  constructor(opts = {}) {
    this.now = opts.now ?? 0;
    this.server = new LabServer(Object.assign({ now: this.now }, opts.server || {}));
    this.peers = [];
  }
  /** makeClient(send) -> a client; its link to the server has `lat` ms each way, plus 0..jit */
  add(makeClient, lat = 40, jit = 0) {
    const up = new Net.Link(true, new Net.Meter()), down = new Net.Link(false, new Net.Meter());
    up.set(lat, jit, 0); down.set(lat, jit, 0);
    const peer = { up, down, client: null, cid: 0, gone: false };
    peer.cid = this.server.connect((buf) => { if (!peer.gone) down.send(this.now, buf); });
    peer.client = makeClient((buf) => { if (!peer.gone) up.send(this.now, buf); });
    this.peers.push(peer);
    return peer;
  }
  setLatency(peer, lat, jit) { peer.up.set(lat, jit, 0); peer.down.set(lat, jit, 0); }
  remove(peer) { peer.gone = true; this.server.disconnect(peer.cid); this.peers = this.peers.filter((p) => p !== peer); }
  /** Deliver every packet and run every server tick due by `now`, in time order */
  advance(now) {
    for (;;) {
      let best = Infinity, link = null, peer = null, toServer = false;
      for (const p of this.peers) {
        const u = p.up.next(); if (u < best) { best = u; link = p.up; peer = p; toServer = true; }
        const d = p.down.next(); if (d < best) { best = d; link = p.down; peer = p; toServer = false; }
      }
      const tickT = this.server.start + (this.server.W.tick + 1) * TICK_MS;
      if (best <= tickT && best <= now) {
        const { t, buf } = link.pop();
        this.now = t;
        if (toServer) this.server.recv(peer.cid, buf, t); else peer.client.recv(buf, t);
        continue;
      }
      if (tickT <= now) { this.now = tickT; this.server.tick(tickT); continue; }
      break;
    }
    this.now = now;
  }
}

NL.Harness = Harness;
if (typeof module === 'object' && module.exports) module.exports = NL;
})(globalThis.NL = globalThis.NL || {});
