/**
 * @contract client.app.server-messages
 * owns:       the table of server messages Game handles itself, keyed by message type, read through MessageHost
 * needs:      @space-game/common ServerMessage, MessageHost (getters over Game), ShipClient for ship messages,
 *             feature and ui stores
 * invariants: the table handles exactly the types pinned in server/src/golden/serverMessages.json —
 *             client/src/app/serverMessages.test.ts
 *             a type ShipClient swallows whole has no entry, and unknown or prototype-ish types are ignored —
 *             client/src/app/serverMessages.test.ts
 * extend:     a new server message is one entry in HANDLERS (or a ShipClient case), then the golden pin
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * Server messages Game handles itself: one table, keyed by message type. Split out of Game.handleServerMessage.
 *
 * Game first offers every message to ShipClient.handleMessage (ship messages, which may also fall through to
 * here: bossPhase, bossDefeated, damage, projectileHit). Then the table is one exact-key lookup, no closure and
 * no spread per message: snapshot, pong and playerState run at tick rate, so keep them cheap.
 * Handlers read the game through MessageHost (getters/setters over Game's fields), never Game itself.
 *
 * A new protocol message needs an entry here (or in ShipClient); see serverMessages.test.ts, which checks
 * every type in server/src/golden/serverMessages.json is in HANDLERS and the table has nothing else.
 */
import type { ServerMessage, DisconnectInfo } from '@space-game/common';
import { noteBossLife } from '../ships/bossLife';
import { fieldClient } from '../ships/field/fieldState';
import { mineClient } from '../ships/features/minebay/mines';
import { onClampAsk, onClampLink, onClampBreak } from '../ships/features/clamp';
import { devFeeds } from './devFeeds';
import { setBank } from '../ui/station/bankStore';
import { setTutorialState, tutorialEdge } from '../ui/tutorial/tutorialStore';
import { showServerUpdate } from '../ui/updateBanner';
import { showHitTick } from '../ui/HitTick';
import { setCombatLock } from '../ui/CombatLockUI';
import { coalesceDelayMs } from '../network/netCaps';
import { onGunRangeState } from '../ui/gunRange/rangeMessages';
import { PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE, unpackRanges } from '@space-game/common';
import type { RibbonsFile } from '@space-game/common';
import ribbonData from '../../../data/achievements.json';
import type { GameState } from '../state/GameState';
import type { PilotState } from '../econ/clientEcon';
import type { Renderer } from '../rendering/Renderer';
import type { AudioManager } from '../audio/AudioManager';
import type { Lazy } from '../lazy';
import type { StationWindow } from '../ui/StationWindow';
import type { ShipClient } from '../ships/ShipClient';
import type { Autopilot } from '../ships/Autopilot';
import type { HazardOverlay } from '../ui/HazardOverlay';
import type { SystemMapUI } from '../ui/SystemMapUI';
import type { PlayerStatsUI } from '../ui/PlayerStatsUI';
import type { FloatingRewardsUI } from '../ui/FloatingRewardsUI';
import type { DamageIndicatorUI } from '../ui/DamageIndicatorUI';
import type { KillFeedUI } from '../ui/KillFeedUI';
import type { ToastUI } from '../ui/PilotHud';
import type { QuestClient } from '../ui/QuestUI';
import type { BuildSites } from '../rendering/BuildSites';
import type { SocialUI } from '../ui/SocialUI';
import type { ChatPanel } from '../ui/ChatPanel';
import type { TradeWindow } from '../ui/TradeWindow';
import type { InfoPanel } from '../ui/InfoPanel';
import type { OpsUI } from '../ui/OpsUI';
import type { PingUI } from '../ui/PingUI';
import type { RibbonPopup } from '../ui/RibbonPopup';
import type { QuickBar } from '../ui/QuickBar';
import type { DialogueUI } from '../ui/DialogueUI';
import type { ObjectiveBanner } from '../ui/ObjectiveBanner';
import type { SiegePanel } from '../ui/SiegePanel';
import type { BossUI } from '../ui/BossUI';
import type { AdminPanel } from '../ui/AdminPanel';
import type { ContributorPanel } from '../ui/ContributorPanel';
import type { ChatBubbles } from '../ui/bubbles/ChatBubbles';

/** What the message handlers read and write on the game (Game supplies it as getters/setters) */
export interface MessageHost {
  readonly network: { disconnect(): void };
  readonly state: GameState;
  readonly pilot: PilotState;
  readonly renderer: Renderer;
  readonly audio: AudioManager;
  readonly shipClient: ShipClient;
  readonly autopilot: Autopilot;
  readonly hazards: HazardOverlay;
  readonly systemNames: Map<string, string>;
  readonly systemMapUI: SystemMapUI;
  readonly playerStatsUI: PlayerStatsUI;
  readonly floatingRewardsUI: FloatingRewardsUI;
  readonly damageIndicatorUI: DamageIndicatorUI;
  readonly killFeedUI: KillFeedUI;
  readonly toasts: ToastUI;
  readonly quests: QuestClient;
  readonly buildSites: BuildSites | null;
  readonly social: SocialUI;
  /** The chat box (private messages go straight to it) */
  readonly chat: Pick<ChatPanel, 'addPrivate'>;
  readonly tradeWindow: TradeWindow;
  readonly infoPanel: InfoPanel;
  readonly opsUI: OpsUI;
  readonly pingUI: PingUI;
  readonly ribbonPopup: RibbonPopup;
  readonly quickBar: QuickBar;
  readonly dialogue: DialogueUI;
  readonly objectives: ObjectiveBanner;
  readonly siegePanel: Lazy<SiegePanel>;
  readonly bossUI: BossUI;
  readonly stationWindow: Lazy<StationWindow>;
  readonly worldEvents: Map<number, { name: string; x: number; y: number; system: string }>;
  readonly adminPanel: AdminPanel | null;
  readonly contribPanel: ContributorPanel | null;
  readonly chatBubbles?: ChatBubbles;
  loggedIn: boolean;
  localDead: boolean;
  statsPrimed: boolean;
  sessionKills: number;
  systemArrivedAt: number;
  perfSrv: number | undefined;
  perfNet: string;
  wreck: { system: string; x: number; y: number; until: number } | null;
  onDisconnected(info?: DisconnectInfo): void;
  netRates(): string;
  addChatMessage(playerName: string, text: string, isSystem?: boolean, color?: string): void;
  showSystemMessage(text: string, color?: string): void;
  handleAuthResult(msg: Msg<'authResult'>): void;
  startContrib(): void;
  stopContrib(): void;
}

type Msg<K extends ServerMessage['type']> = Extract<ServerMessage, { type: K }>;
type Handler<K extends ServerMessage['type']> = (h: MessageHost, msg: Msg<K>) => void;
type Handlers = { [K in ServerMessage['type']]?: Handler<K> };

// ---- Named handlers (the cases with bigger bodies) ----

function welcome(h: MessageHost, msg: Msg<'welcome'>): void {
  // A server on another protocol version (it echoes its own): our decoding can't be trusted
  if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) {
    console.warn(`Server protocol ${msg.protocol}, this client ${PROTOCOL_VERSION}`);
    h.network.disconnect();
    h.onDisconnected({ code: PROTOCOL_MISMATCH_CLOSE, reason: 'version', retrying: false });
    return;
  }
  h.state.playerId = msg.playerId;
  h.shipClient.onWelcome();
  h.state.tickRate = msg.tickRate;
  if (msg.threats) h.state.threats = msg.threats;
  if (msg.regionThreats) h.state.regionThreats = msg.regionThreats;
  h.loggedIn = true;
  h.renderer.hideDeathScreen(); // welcome also follows a respawn
  h.localDead = false;
  h.social?.showRally(false);
  console.log('Joined as player', msg.playerId);
}

function pong(h: MessageHost, msg: Msg<'pong'>): void {
  h.state.handlePong(msg.clientTime, msg.serverTime, msg.tick);
  h.perfSrv = msg.serverProcessing;
  h.perfNet = h.netRates().replace(/^ \| /, '');
}

function playerState(h: MessageHost, msg: Msg<'playerState'>): void {
  // Track credit gains for stats (not the first update after joining: that's what you had, not a gain)
  if (h.statsPrimed && msg.credits > h.state.credits) {
    const creditGain = msg.credits - h.state.credits;
    h.playerStatsUI.addCreditsEarned(creditGain);
    // Show floating credit text near player
    const playerPos = h.state.getPlayerPosition();
    h.floatingRewardsUI.addCredits(playerPos.x, playerPos.y, creditGain);
  }
  // Track XP gains for stats
  if (h.statsPrimed && (msg.xp > h.state.xp || msg.level > h.state.level)) {
    const xpGain = msg.xp - h.state.xp;
    if (xpGain > 0) {
      const playerPos = h.state.getPlayerPosition();
      h.floatingRewardsUI.addXP(playerPos.x, playerPos.y, xpGain, msg.level > h.state.level);
    }
  }
  // (hp and boost fuel come timed in every snapshot's own row; this message's are untimed, so they only seed the first
  // value, or a flicker back to an old hp / fuel follows each message)
  if (!h.statsPrimed) {
    h.state.hp = msg.hp;
    h.state.boostFuel = msg.boostFuel;
    h.state.serverBoostFuel = msg.boostFuel;
  }
  h.state.maxHp = msg.maxHp;
  h.state.maxBoostFuel = msg.maxBoostFuel;
  // Sounds for gains and travel (not for the first update after joining)
  if (h.statsPrimed) {
    if (msg.level > h.state.level) h.audio.playUI('level_up');
    else if (msg.credits > h.state.credits) h.audio.playUI('credits', 0.8);
    if (msg.systemId !== h.state.systemId) h.audio.playUI('warp');
  }
  if (msg.systemId !== h.state.systemId) h.systemArrivedAt = performance.now();
  h.statsPrimed = true;
  h.state.xp = msg.xp;
  h.state.level = msg.level;
  h.state.credits = msg.credits;
  // Clear deterministic asteroids on system change
  if (msg.systemId !== h.state.systemId) {
    h.state.clearDeterministicAsteroids();
    h.state.clearForSystemChange();
    // (ships kept from the system it left: CAPS.FOCUS)
    h.shipClient.away.clear();
  }
  h.state.systemId = msg.systemId;
}

function systemInfo(h: MessageHost, msg: Msg<'systemInfo'>): void {
  // Data-driven system visuals from the server (central body + starfield)
  h.renderer.setSystemInfo(msg);
  h.systemNames.set(msg.systemId, msg.name);
  h.hazards.setHazards(msg.hazards ?? []);
  // Feed the system map
  h.systemMapUI.setSystemInfo({
    name: msg.name,
    sector: msg.sector,
    centralBody: msg.centralBody as any,
  });
}

function gained(h: MessageHost, msg: Msg<'gained'>): void {
  if (msg.source?.startsWith('kill:') || msg.source?.startsWith('assist:')) h.sessionKills++;
  const at = msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y } : h.state.getPlayerPosition();
  let k = 0;
  for (const [id, n] of Object.entries(msg.items)) {
    const d = h.pilot.econ.items.get(id);
    h.floatingRewardsUI.addItem(at.x, at.y - k++ * 26, `+${n} ${d?.name ?? id}`, d?.rarity ?? 'common');
  }
  if (k) h.audio.playUI('credits', 0.35);
  // (Ore you broke off: the drop your mining progress ring was filling towards)
  if (k && msg.source === 'mined') h.shipClient.minedDrop();
  if (msg.xp) h.floatingRewardsUI.addXP(at.x + 40, at.y - k * 26, msg.xp);
  if (msg.credits) h.floatingRewardsUI.addCredits(at.x - 40, at.y - k * 26, msg.credits);
  if (msg.source?.startsWith('kill:')) {
    h.killFeedUI.addEnemyDefeat(h.state.playerName, msg.source.slice(5), true);
    h.playerStatsUI.addEnemyDefeated();
    h.audio.playUI('credits', 0.6);
  }
}

function damage(h: MessageHost, msg: Msg<'damage'>): void {
  h.renderer.showDamageNumber(msg.targetId, msg.amount, msg.critical, msg.glancing);
  h.renderer.hitEntity(msg.targetId, msg.amount);
  // Update entity HP if included (deterministic asteroids)
  if (msg.hp !== undefined) {
    const dmgEntity = h.state.entities.get(msg.targetId);
    if (dmgEntity) {
      dmgEntity.hp = msg.hp;
      if (msg.maxHp !== undefined) dmgEntity.maxHp = msg.maxHp;
    }
  }
  // Show damage indicator if local player is the target
  if (msg.targetId === h.state.playerId) {
    // The indicator points at whoever fired (when we can see them); otherwise it's just a flash
    const src = msg.sourceId !== undefined && msg.sourceId !== msg.targetId ? h.state.entities.get(msg.sourceId) : undefined;
    const playerPos = h.state.getPlayerPosition();
    h.damageIndicatorUI.addDamage(
      src ? src.renderX : playerPos.x,
      src ? src.renderY : playerPos.y,
      Math.min(1, msg.amount / 50) // Normalize intensity
    );
    // Track damage taken
    h.playerStatsUI.addDamageTaken(msg.amount);
  } else if (msg.sourceId === h.state.playerId) {
    // Track damage dealt
    h.playerStatsUI.addDamageDealt(msg.amount);
    h.playerStatsUI.addShotHit();
    showHitTick(msg.amount, msg.critical);
  }
  // Your own hull taking it: a thump (impacts on others sound from projectileHit)
  if (msg.targetId === h.state.playerId) {
    h.audio.playUI('hurt', Math.min(1, 0.4 + msg.amount / 40));
    h.audio.bumpCombat(1);
  }
}

function death(h: MessageHost, msg: Msg<'death'>): void {
  if (msg.entityId === h.state.playerId) {
    // (The blast itself sounds from the core's partDestroyed message)
    h.renderer.showDeathScreen(msg.killerId !== undefined ? h.state.entities.get(msg.killerId)?.name : undefined);
    h.killFeedUI.addSystemMessage('You were destroyed');
    h.autopilot.cancel();
    h.localDead = true;
    h.social.showRally(true);
  } else {
    h.renderer.showExplosion(msg.entityId);
    // Get dead entity info
    const deadEntity = h.state.entities.get(msg.entityId);
    if (deadEntity) h.audio.play('explosion_large', deadEntity.x, deadEntity.y);
  }
}

// ---- The table ----
// (Hot ones first. One entry per line: structure.test.ts reads these keys.)

const TABLE: Handlers = {
  // (Its gun rows first: the lanes take them before the snapshot's own processing, as when they came apart)
  snapshot: (h, msg) => { if (msg.gun) h.shipClient.onGunCtl({ t: msg.tick, r: msg.gun }); h.state.applySnapshot(msg); h.shipClient.afterSnapshot(msg); },
  pong,
  playerState,
  welcome,
  systemInfo,
  profile: (h, msg) => {
    if (h.pilot.profile && msg.level > h.pilot.profile.level) h.audio.playUI('level_up');
    h.pilot.setProfile(msg);
  },
  profileDelta: (h, msg) => {
    if (msg.level !== undefined && h.pilot.profile && msg.level > h.pilot.profile.level) h.audio.playUI('level_up');
    h.pilot.setProfileDelta(msg);
  },
  items: (h, msg) => { h.pilot.setItems(msg); },
  gained,
  wreck: (h, msg) => {
    h.wreck = msg.gone || msg.system === undefined ? null : { system: msg.system, x: msg.x ?? 0, y: msg.y ?? 0, until: Date.now() + (msg.seconds ?? 0) * 1000 };
  },
  toast: (h, msg) => {
    h.toasts.show(msg.text, msg.kind);
    if (msg.kind === 'bad') h.audio.playUI('error', 0.5);
    else if (msg.text.startsWith('Fabrication complete')) h.audio.playUI('craft_done', 0.8);
  },
  rebuild: (h, msg) => { h.pilot.setRebuild(msg); },
  station: (h, msg) => { h.stationWindow.use((w) => w.setStation(msg)); },
  // The gun range: in or out, the weapon flown and the ones on offer (ui/gunRange/rangeMessages.ts)
  gunRangeState: (h, msg) => { onGunRangeState(h, msg); },
  vendors: (h, msg) => { h.stationWindow.use((w) => w.setVendors(msg)); },
  marketScan: (h, msg) => { h.stationWindow.use((w) => w.setScan(msg)); },
  quests: (h, msg) => {
    h.quests.setQuests(msg);
    h.buildSites?.set(msg.builds);
  },
  codex: (h, msg) => { h.quests.setCodex(msg); },
  hangar: (h, msg) => { h.pilot.setHangar(msg); },
  party: (h, msg) => { h.social.setParty(msg); },
  partyInvite: (h, msg) => { h.social.onInvite(msg); },
  tradeRequest: (h, msg) => { h.social.onTradeRequest(msg); },
  friends: (h, msg) => { h.social.setFriends(msg); },
  friendRequest: (h, msg) => { h.social.onFriendRequest(msg); },
  whisper: (h, msg) => { h.chat.addPrivate(msg); },
  trade: (h, msg) => { h.tradeWindow.onTrade(msg); },
  pilotInfo: (h, msg) => { h.infoPanel.onInfo(msg); },
  ops: (h, msg) => { h.opsUI.setOps(msg); },
  mapPing: (h, msg) => { h.pingUI.onPing(msg); },
  ribbon: (h, msg) => {
    const def = (ribbonData as unknown as RibbonsFile).ribbons.find((r) => r.id === msg.id);
    if (def) h.ribbonPopup.show(def, msg.credits, msg.xp);
  },
  ribbons: (h, msg) => { h.quests.setRibbons(msg); },
  rankings: (h, msg) => { h.quests.setRankings(msg); },
  news: (h, msg) => {
    // The galaxy's news: in the chat log, and fresh stories in the event feed too
    h.addChatMessage('Galaxy', msg.text, true);
    if (!msg.old) {
      h.killFeedUI.addSystemMessage(msg.text);
      if (msg.kind === 'boss' || msg.kind === 'fleet') h.audio.playUI('scan_ping', 0.4);
    }
  },
  sharedDesign: (h, msg) => {
    h.shipClient.addSharedDesign(msg.from, msg.blueprint);
    h.toasts?.show(`${msg.from} shared the ${msg.blueprint.name}. Open the hangar at a station and pick it under Load → Shared with you`, 'info');
    h.audio.playUI('scan_ping', 0.5);
  },
  fieldState: (_h, msg) => { fieldClient.applyState(msg); },
  fieldDone: (h, msg) => {
    const line = fieldClient.applyDone(msg, (id) => h.pilot.econ.items.name(id));
    if (!line) return;
    h.toasts.show(line, 'good');
    h.audio.playUI('craft_done', 0.5);
  },
  repairBank: (_h, msg) => { setBank(msg); },
  // (Quitting now would leave the ship in space: the HUD counts the lock down, ui/CombatLockUI.ts)
  combatLock: (_h, msg) => { setCombatLock(msg.left); },
  tutorialState: (_h, msg) => { setTutorialState(msg); },
  tutorialEdge: () => { tutorialEdge(); },
  serverUpdate: (_h, msg) => { showServerUpdate(msg.inMs); },
  minesLaid: (h, msg) => { mineClient.laid(msg, h.state.playerId); },
  minesGone: (_h, msg) => { mineClient.gone(msg); },
  minesKept: (_h, msg) => { mineClient.kept(msg); },
  mineBay: (_h, msg) => { mineClient.bayState(msg); },
  questBoard: (h, msg) => { h.quests.setBoard(msg); },
  talk: (h, msg) => { h.dialogue.set(msg.view); },
  people: (h, msg) => { h.quests.setPeople(msg.people); },
  worldEvent: (h, msg) => {
    h.worldEvents.set(msg.id, { name: msg.title, x: msg.x, y: msg.y, system: h.state.systemId });
    setTimeout(() => h.worldEvents.delete(msg.id), msg.seconds * 1000 + 5000);
    if (msg.kind === 'raid') h.audio.playUI('warning', 0.7);
  },
  worldEventEnd: (h, msg) => { h.worldEvents.delete(msg.id); },
  objective: (h, msg) => {
    h.objectives.show(msg, h.state.systemId);
    if (msg.night !== undefined) h.renderer.setNight(msg.night);
  },
  objectiveEnd: (h, msg) => {
    h.objectives.end(msg.id);
    h.renderer.setNight(0);
  },
  siegeState: (h, msg) => {
    h.siegePanel.use((p) => p.update(msg));
    if (!msg.active) h.renderer.setNight(0);
  },
  bossIntro: (h, msg) => { h.bossUI.intro(msg.name, msg.title, msg.text); },
  mapDots: (h, msg) => { h.state.farShips.apply(msg, h.state.systemId, h.state.getRawServerTick()); },
  pops: (h, msg) => { h.state.populations.apply(msg, h.state.systemId); },
  bossPhase: (h, msg) => {
    // (no line: a reminder of the phase it's in, for someone arriving mid-fight)
    if (msg.text) h.bossUI.onPhase(msg.text);
  },
  bossDefeated: (h, msg) => { h.bossUI.defeated(msg.name); },
  // (A lair boss waking, sinking back, gone: drawn from its tick, ships/bossLife.ts)
  bossLife: (h, msg) => {
    noteBossLife(msg);
    if (msg.state === 'waking') h.audio.playUI('warning', 0.6);
  },
  bossWindow: (h, msg) => { h.bossUI.window(msg); },
  bossDev: (_h, msg) => { devFeeds.bossDev?.(msg); },
  questStep: (h, msg) => {
    // (A finished job: the reward screen, ui/rewards)
    if (msg.done) { h.quests.jobDone(msg.done); return; }
    h.quests.stepDone(msg.text);
    h.toasts.show(`Next: ${msg.text}`, 'info');
  },
  damage,
  // (Confirmed hits: each record handled as the messages it stands for, ships/hits/ConfirmedHits.ts)
  hits: (h, msg) => { h.shipClient.onHits(msg, (m) => handleServerMessage(h, m)); },
  hpCheck: (h, msg) => { h.shipClient.onHpCheck(msg); },
  // (Client-detected hits, part D: a correction; netCaps: finding them starts, and its confirmation level)
  hitFix: (h, msg) => { h.shipClient.onHitFix(msg, (m) => handleServerMessage(h, m)); },
  // (Its system's crowd level: the focus radius and fade, the window, its clock's rate from a tick)
  crowd: (h, msg) => { h.state.onCrowd(msg); },
  // (Its own ship's stores, guns, hazards and priming put right, exact: its tick layer steps again from there)
  ownSync: (h, msg) => { h.shipClient.onOwnSync(msg); },
  // (Other ships' gun lanes, and pilots' gun controls: their guns stepped here from their inputs, ships/guns/OtherGuns.ts)
  gunSync: (h, msg) => { h.shipClient.onGunSync(msg); },
  // (Docking Clamps: the other pilot's press, a lock or swap, letting go: ships/features/clamp)
  clampAsk: (_h, msg) => { onClampAsk(msg); },
  clampLink: (h, msg) => { onClampLink(msg, h.shipClient.replicas, h.state.playerId); },
  clampBreak: (h, msg) => { onClampBreak(msg, h.shipClient.replicas, h.state.playerId); },
  // (Pull fields its tick layer works out itself, opened or ended early: before the snapshot they go with)
  pulls: (h, msg) => { h.shipClient.onPulls(msg); },
  netCaps: (h, msg) => { h.shipClient.onNetCaps(msg.lvl); h.state.coalesceMs = coalesceDelayMs(msg.hold, msg.lvl); },
  projectileHit: (h, msg) => {
    // (its sound is its impact's, heard where and when it's drawn: WeaponFx.impactAt -> audio/CombatSounds.ts)
    h.renderer.showProjectileHit(msg.id, msg.x, msg.y);
  },
  asteroidSpawn: (h, msg) => { h.state.handleAsteroidSpawn(msg.tick, msg.asteroids); },
  asteroidSeed: (h, msg) => {
    h.state.handleAsteroidSeed(msg.tick, msg.systemId, msg.seed, msg.belt, unpackRanges(msg.ids), unpackRanges(msg.indices), msg.asteroidField);
    // Feed belt geometry to the system map
    if (msg.belt) {
      h.systemMapUI.setBelt(msg.belt.innerRadius, msg.belt.outerRadius);
    }
  },
  asteroidDebug: (h, msg) => { h.renderer.showAsteroidDebug(msg.points, msg.durationMs); },
  death,
  effect: (h, msg) => { h.renderer.showEffect(msg.effectType, msg.x, msg.y, msg.data, msg.targetX, msg.targetY, msg.entityId); },
  systemMessage: (h, msg) => { h.showSystemMessage(msg.text, msg.color); },
  // (dev weapons range readout: nobody listens outside a dev build)
  chat: (h, msg) => {
    h.addChatMessage(msg.playerName, msg.text);
    // (Public chat only: party lines come as playerId 0, not a ship)
    if (msg.playerId > 0) h.chatBubbles?.say(msg.playerId, msg.playerName, msg.text);
  },
  authResult: (h, msg) => { h.handleAuthResult(msg); },
  adminStats: (h, msg) => { h.adminPanel?.onStats(msg); },
  adminInfo: (h, msg) => { h.adminPanel?.onInfo(msg); },
  adminAccounts: (h, msg) => { h.adminPanel?.onAccounts(msg); },
  contribRank: (h, msg) => {
    if (msg.on) h.startContrib(); else h.stopContrib();
    h.addChatMessage('', msg.on ? 'You are a contributor: F6 opens the contributor notes.' : 'Your contributor rank was removed.', true, '#5eead4');
  },
  contribNotes: (h, msg) => { h.contribPanel?.onNotes(msg.system, msg.notes); },
  contribNote: (h, msg) => { h.contribPanel?.onNote(msg.note); },
  contribNoteGone: (h, msg) => { h.contribPanel?.onGone(msg.id); },
  contribResult: (h, msg) => {
    h.contribPanel?.onResult(msg.ok, msg.text);
    if (!h.contribPanel?.isOpen) h.addChatMessage('', msg.text, true, msg.ok ? '#9fe0b5' : '#ff9a8a');
  },
  adminResult: (h, msg) => {
    h.adminPanel?.onResult(msg.ok, msg.text);
    // Chat commands answer in the chat (the panel may be shut)
    if (!h.adminPanel?.isOpen) h.addChatMessage('', msg.text, true, msg.ok ? '#9fe0b5' : '#ff9a8a');
  },
};

/** Same table, without Object.prototype behind it (a hostile "type" like "__proto__" finds nothing) */
export const HANDLERS: Handlers = Object.setPrototypeOf(TABLE, null);

/** One server message: the ship's messages first, then the table (an exact-key lookup) */
export function handleServerMessage(h: MessageHost, msg: ServerMessage): void {
  if (h.shipClient.handleMessage(msg)) return;
  const fn = HANDLERS[msg.type] as ((h: MessageHost, msg: ServerMessage) => void) | undefined;
  if (fn !== undefined) fn(h, msg);
}
