/**
 * @contract server.net.handlers.modules
 * owns:       client messages that only forward to one game module: party, trade, market, items, gems, quests,
 *             stations, sieges, contributor notes, admin
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx, ClientConnection, the game modules reached through ctx;
 *             @space-game/common
 * invariants: the types it registers are part of the pinned dispatched set — server/src/golden/structure.test.ts
 * extend:     a new forwarding message is a t.on line in its register function; anything with logic goes in its own
 *             area file
 */

/**
 * Client messages that only forward to one game module: party, trade, market and vendors, items, gems, quests,
 * stations, hangar orders, sieges, contributor notes, admin. Moved verbatim from GameServer's message switch
 * (the receiver `this` became `ctx`); every Number/String/slice coercion of hostile input is kept exactly as written.
 */
import { InSystem } from '@space-game/common';
import type { HandlerRegistry } from '../dispatch.js';

/** What a job or a hangar order can be told to do */
const ORDER_ACTIONS = new Set(['pause', 'resume', 'cancel', 'top'] as const);

export function registerModuleHandlers(t: HandlerRegistry): void {
  t.on('partyInvite', (ctx, conn, msg) => {
    ctx.party.invite(conn, { name: msg.name, id: msg.id });
  });
  t.on('ribbons', (ctx, conn, msg) => {
    ctx.achievements.progress(conn);
  });
  t.on('rankings', (ctx, conn, msg) => {
    ctx.achievements.rankings(conn);
  });
  t.on('mapPing', (ctx, conn, msg) => {
    if (ctx.flying(conn.playerId)) ctx.party.ping(conn, msg, ctx.gameData.getSystemByNum(InSystem.systemId[conn.playerId])?.id ?? '');
  });
  t.on('partyRespond', (ctx, conn, msg) => {
    ctx.party.respond(conn, !!msg.accept);
  });
  t.on('partyLeave', (ctx, conn, msg) => {
    ctx.party.leave(conn);
  });
  t.on('partyKick', (ctx, conn, msg) => {
    ctx.party.kick(conn, String(msg.name));
  });
  t.on('partyPromote', (ctx, conn, msg) => {
    ctx.party.promote(conn, String(msg.name));
  });
  t.on('tradeRequest', (ctx, conn, msg) => {
    ctx.trade.request(conn, msg);
  });
  t.on('tradeRespond', (ctx, conn, msg) => {
    ctx.trade.respond(conn, msg);
  });
  t.on('tradeOffer', (ctx, conn, msg) => {
    ctx.trade.offer(conn, msg);
  });
  t.on('tradeAccept', (ctx, conn, msg) => {
    ctx.trade.accept(conn);
  });
  t.on('tradeCancel', (ctx, conn, msg) => {
    ctx.trade.cancel(conn);
  });
  t.on('vendorOpen', (ctx, conn, msg) => {
    ctx.market.vendors(conn);
  });
  t.on('vendorBuy', (ctx, conn, msg) => {
    ctx.market.buy(conn, msg);
  });
  t.on('marketScan', (ctx, conn, msg) => {
    ctx.market.scan(conn, Array.isArray(msg.items) ? msg.items.slice(0, 80).map(String) : []);
  });
  t.on('itemMove', (ctx, conn, msg) => {
    ctx.pilots.handleMove(conn, msg);
  });
  t.on('itemJettison', (ctx, conn, msg) => {
    ctx.pilots.handleJettison(conn, msg);
  });
  t.on('itemUse', (ctx, conn, msg) => {
    ctx.pilots.handleUse(conn, msg);
  });
  t.on('stationOpen', (ctx, conn, msg) => {
    ctx.services.open(conn);
    ctx.quests.board(conn);
  });
  t.on('refine', (ctx, conn, msg) => {
    ctx.services.refine(conn, msg);
  });
  t.on('craft', (ctx, conn, msg) => {
    ctx.services.craft(conn, msg);
  });
  t.on('outpostCharter', (ctx, conn, msg) => {
    ctx.outpost?.charter(conn, String(msg.site));
  });
  t.on('outpostUpgrade', (ctx, conn, msg) => {
    ctx.outpost?.upgrade(conn, String(msg.track));
  });
  t.on('ammoPrefer', (ctx, conn, msg) => {
    ctx.ammo.prefer(conn, String(msg.item));
  });
  t.on('slotLoadout', (ctx, conn, msg) => {
    ctx.ammo.setLoadout(conn, Math.floor(Number(msg.slot)), msg.load, msg.first);
  });
  t.on('restockLoadout', (ctx, conn, msg) => {
    ctx.ammo.restock(conn, { report: true });
  });
  t.on('itemStore', (ctx, conn, msg) => {
    ctx.pilots.handleStore(conn, msg.what);
  });
  t.on('gemCut', (ctx, conn, msg) => {
    ctx.services.cutGem(conn, msg);
  });
  t.on('gemSocket', (ctx, conn, msg) => {
    ctx.hangar.socketGem(conn, Math.floor(Number(msg.slot)), Math.floor(Number(msg.uid)), String(msg.gem));
  });
  t.on('gemUnsocket', (ctx, conn, msg) => {
    ctx.hangar.unsocketGem(conn, Math.floor(Number(msg.slot)), Math.floor(Number(msg.uid)), Math.floor(Number(msg.index)));
  });
  t.on('marketSell', (ctx, conn, msg) => {
    ctx.services.sell(conn, msg);
  });
  t.on('marketBuy', (ctx, conn, msg) => {
    ctx.services.buy(conn, msg);
  });
  t.on('questBoard', (ctx, conn, msg) => {
    ctx.quests.board(conn);
  });
  t.on('questAccept', (ctx, conn, msg) => {
    ctx.quests.accept(conn, msg);
  });
  t.on('talk', (ctx, conn, msg) => {
    ctx.people.handle(conn, msg);
  });
  t.on('questAbandon', (ctx, conn, msg) => {
    ctx.quests.abandon(conn, msg);
  });
  t.on('questSeen', (ctx, conn, msg) => {
    ctx.quests.seen(conn);
  });
  t.on('codexRead', (ctx, conn, msg) => {
    ctx.codex.read(conn, msg);
  });
  t.on('skillUp', (ctx, conn, msg) => {
    ctx.quests.skillUp(conn, msg);
  });
  t.on('fabOrder', (ctx, conn, msg) => {
    ctx.hangar.orderItem(conn, String(msg.item), Math.floor(Number(msg.n)));
  });
  t.on('fabOrderCancel', (ctx, conn, msg) => {
    ctx.hangar.cancelOrder(conn, Math.floor(Number(msg.id)));
  });
  t.on('designDelete', (ctx, conn, msg) => {
    ctx.hangar.deleteDesign(conn, Math.floor(Number(msg.slot)));
  });
  t.on('slotBuild', (ctx, conn, msg) => {
    ctx.hangar.build(conn, Math.floor(Number(msg.slot)));
  });
  t.on('slotOrder', (ctx, conn, msg) => {
    if (ORDER_ACTIONS.has(msg.action)) ctx.hangar.order(conn, Math.floor(Number(msg.slot)), msg.action);
  });
  t.on('job', (ctx, conn, msg) => {
    if (ORDER_ACTIONS.has(msg.action)) ctx.services.jobAction(conn, Math.floor(Number(msg.id)), msg.action);
  });
  t.on('scrapItem', (ctx, conn, msg) => {
    ctx.pilots.scrapItem(conn, String(msg.id), Math.floor(Number(msg.n)));
  });
  t.on('marketSellAll', (ctx, conn, msg) => {
    ctx.services.sellAll(conn);
  });
  t.on('quickbarSet', (ctx, conn, msg) => {
    ctx.pilots.setQuickbar(conn, msg);
  });
  t.on('contrib', (ctx, conn, msg) => {
    ctx.contrib.handle(conn, msg as unknown as Record<string, unknown>);
  });
  t.on('admin', (ctx, conn, msg) => {
    ctx.admin.run(conn, String(msg.cmd ?? ''), msg.args && typeof msg.args === 'object' ? msg.args : {});
  });
  t.on('siege', (ctx, conn, msg) => {
    ctx.sieges.handle(conn, msg, conn.playerId);
  });
}
