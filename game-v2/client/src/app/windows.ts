/**
 * The windows registry (split out of Game.init): builds every in-game window and HUD component, wires their
 * callbacks, and returns them as one WindowSet. windows.ts never imports Game; it reads a WindowHost that Game
 * supplies as getters, so state built later (the menu, the admin panel) resolves at use.
 *
 * ORDER MATTERS: windows are built in the order Game.init always built them, because later ones close over
 * earlier ones (and a few are read by the callbacks of others), and the renderer must exist already. The key and
 * Esc/modal order is not here: that chain lives in app/keys.ts.
 */
import { jumpTuning, jumpRange, chooseCrate, crateOrder, cratesFor, ammoByCode, ammoCode, ShipTuning, QuestTarget, QuestsFile, type StarSystemData } from '@space-game/common';
import shipTuning from '../../../data/ships/tuning.json';
import questsData from '../../../data/quests.json';
import systemsDataForMenu from '../../../data/systems.json';
import { Autopilot, type AutoDest } from '../ships/Autopilot';
import { itemIcon } from '../ui/itemIcons';
import { InventoryWindow } from '../ui/InventoryWindow';
import { PilotHud, ToastUI } from '../ui/PilotHud';
import { CargoPanelUI } from '../ui/CargoPanelUI';
import { RegionUI } from '../ui/RegionUI';
import { BuildSites } from '../rendering/BuildSites';
import { KillFeedUI } from '../ui/KillFeedUI';
import { PlayerStatsUI } from '../ui/PlayerStatsUI';
import { NavMarkersUI } from '../ui/NavMarkersUI';
import { FarZoomMarkers } from '../ui/FarZoomMarkers';
import { ChatBubbles } from '../ui/bubbles/ChatBubbles';
import { SocialUI } from '../ui/SocialUI';
import { InfoPanel } from '../ui/InfoPanel';
import { TradeWindow } from '../ui/TradeWindow';
import { TargetUI } from '../ui/TargetUI';
import { OpsUI } from '../ui/OpsUI';
import { PingUI } from '../ui/PingUI';
import { RibbonPopup } from '../ui/RibbonPopup';
import { QuestClient } from '../ui/QuestUI';
import { DialogueUI } from '../ui/DialogueUI';
import { PeopleUI, TALK_RANGE } from '../ui/PeopleUI';
import { ContextActions } from '../input/ContextActions';
import { GuideUI } from '../ui/GuideUI';
import { BossUI } from '../ui/BossUI';
import { QuickBar } from '../ui/QuickBar';
import { SystemMapUI } from '../ui/SystemMapUI';
import { ObjectiveBanner } from '../ui/ObjectiveBanner';
import { HubPanel } from '../ui/hub/HubPanel';
import { socialTab } from '../ui/hub/tabs/socialTab';
import { partyTab } from '../ui/hub/tabs/partyTab';
import { pilotTab } from '../ui/hub/tabs/pilotTab';
import { componentsTab } from '../ui/hub/tabs/componentsTab';
import { fabTab } from '../ui/hub/tabs/fabTab';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';
import type { GameMenuUI, MenuPilotInfo } from '../ui/GameMenuUI';
import type { AdminPanel } from '../ui/AdminPanel';
import type { ComponentGuideUI } from '../ui/ComponentGuideUI';
import type { StationWindow } from '../ui/StationWindow';
import type { TutorialUI } from '../ui/tutorial/TutorialUI';
import type { GunRangeHud } from '../ui/gunRange/GunRangeHud';
import type { Lazy } from '../lazy';
import type { AudioManager } from '../audio/AudioManager';
import type { InputManager } from '../input/InputManager';
import type { Renderer } from '../rendering/Renderer';
import type { Prediction } from '../predict/Prediction';
import type { ShipClient } from '../ships/ShipClient';
import type { GameState } from '../state/GameState';
import type { PilotState } from '../econ/clientEcon';
import type { ClientTransport } from '@space-game/common';
import { makeComponentGuide, makeStationWindow, makeTutorialUI, makeGunRangeHud } from './lazyScreens';
import { inGunRange } from '../ui/gunRange/rangeState';

/** What the windows read from the game (Game supplies it as getters, so later-built state resolves at use) */
export interface WindowHost {
  readonly state: GameState;
  readonly pilot: PilotState;
  readonly network: ClientTransport;
  readonly audio: AudioManager;
  readonly shipClient: ShipClient;
  /** Other ships' prediction (predict/Prediction.ts) */
  readonly prediction: Prediction | null;
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly regionUI: RegionUI;
  readonly objectives: ObjectiveBanner;
  readonly worldEvents: Map<number, { name: string; x: number; y: number; system: string }>;
  readonly wreck: { system: string; x: number; y: number; until: number } | null;
  readonly sessionKills: number;
  readonly loggedIn: boolean;
  readonly localDead: boolean;
  readonly jumpZoom: number;
  readonly stationOpen: boolean;
  readonly menu: GameMenuUI;
  readonly adminPanel: AdminPanel | null;
  objective(): QuestTarget | null;
  flyTo(dest: AutoDest, note?: string): void;
  showSystemMessage(text: string, color?: string): void;
  currentSystem(): StarSystemData | undefined;
  planetBelow(): string | null;
  wreckMarker(): { name: string; x: number; y: number; system: string }[];
  /** A moon siege's fronts on their way (edge arrows with a countdown) */
  siegeMarkers(): { name: string; x: number; y: number; system: string }[];
  toggleAutopilotToObjective(): void;
  /** Start a private message to this pilot in the chat box */
  chatTo(name: string): void;
  /** Friends online changed (the chat box's Friends button) */
  friendsOnline(n: number): void;
  /** You as the pilot readout shows you (the Esc menu's front page and the side panel's Pilot tab) */
  pilotInfo(): MenuPilotInfo;
}

export interface WindowSet {
  inventoryWindow: InventoryWindow;
  componentGuide: Lazy<ComponentGuideUI>;
  stationWindow: Lazy<StationWindow>;
  pilotHud: PilotHud;
  cargoPanel: CargoPanelUI;
  quests: QuestClient;
  toasts: ToastUI;
  dialogue: DialogueUI;
  guide: GuideUI;
  bossUI: BossUI;
  quickBar: QuickBar;
  autopilot: Autopilot;
  /** The right-click menu: dock, travel, land, talk, target, fly or jump there (ContextActions.ts) */
  context: ContextActions;
  social: SocialUI;
  /** The side panel on the left of the HUD, on top of the cargo panel: Social, Party, Pilot, Components (ui/hub) */
  hub: HubPanel;
  infoPanel: InfoPanel;
  tradeWindow: TradeWindow;
  targetUI: TargetUI;
  opsUI: OpsUI;
  ribbonPopup: RibbonPopup;
  pingUI: PingUI;
  /** The training-yard lesson (card, markers, ghosts) */
  tutorialUI: Lazy<TutorialUI>;
  killFeedUI: KillFeedUI;
  playerStatsUI: PlayerStatsUI;
  systemMapUI: SystemMapUI;
  farMarkers: FarZoomMarkers;
  /** Public chat over pilots' ships (ui/bubbles) */
  chatBubbles: ChatBubbles;
  /** Proto's empty scene has nothing to navigate to: these three stay null there */
  peopleUI: PeopleUI | null;
  navMarkers: NavMarkersUI | null;
  /** Structures you've built or are building (drawn for you alone) */
  buildSites: BuildSites | null;
  /** The gun range's banner, target bar, door prompt and weapon picker (ui/gunRange) */
  gunRangeHud: Lazy<GunRangeHud>;
}

export function buildWindows(host: WindowHost, uiOverlay: HTMLElement): WindowSet {
  const w = { peopleUI: null, navMarkers: null, buildSites: null } as unknown as WindowSet;
    w.inventoryWindow = new InventoryWindow(host.pilot, (m) => host.network.send(m), (id) => host.audio.playUI(id, id === 'ui_click' ? 0.4 : 0.6));
    w.componentGuide = makeComponentGuide(host);
    w.pilotHud = new PilotHud(host.pilot);
    w.cargoPanel = new CargoPanelUI(host.pilot, (m) => host.network.send(m), (id) => host.audio.playUI(id, 0.4));
    // (Below the pilot readout and the party list, and below the side panel once it's placed: HubPanel.cargoCeiling)
    w.cargoPanel.ceiling = () => w.hub?.cargoCeiling() || Math.max(w.pilotHud.bottom(), w.social?.hudBottom() ?? 0);
    // (The load is weighed against the ship you fly: common/src/ships/load.ts)
    w.cargoPanel.ship = () => host.shipClient.myShip()?.derived ?? null;
    host.shipClient.ownAmmo = (kind) => {
      // (The gun range: every gun fires its kind's standard crate, as the server's Ammo.setFree does)
      if (inGunRange()) { const std = cratesFor(shipTuning as ShipTuning, kind)[0]; return std ? ammoByCode(ammoCode(std))?.mods : undefined; }
      const prof = host.pilot.profile;
      const pick = chooseCrate(crateOrder(cratesFor(shipTuning as ShipTuning, kind), prof?.loadout), prof?.ammoPrefer?.[kind], prof?.ammo ?? {}, (id) => host.pilot.cargo.some((s) => s.id === id && s.n > 0));
      return pick ? ammoByCode(ammoCode(pick.item))?.mods : undefined;
    };
    w.pilotHud.ammoKinds = () => {
      const ship = host.shipClient?.myShip();
      // (The gun range's ammunition is unlimited: nothing to count)
      if (!ship || inGunRange()) return [];
      const out = new Set<string>();
      for (const w of ship.derived.weapons) { const a = (shipTuning as ShipTuning).weapons?.[w.kind]?.ammo; if (a) out.add(a.item); }
      // Special crates aboard for these guns too
      const kinds = new Set(ship.derived.weapons.map((w) => w.kind));
      for (const st of host.pilot.cargo) if (kinds.has(host.pilot.econ.items.get(st.id)?.ammoFor?.weapon ?? '')) out.add(st.id);
      return [...out];
    };
    w.quests = new QuestClient({ pilot: host.pilot, send: (m) => host.network.send(m), sound: (id, v) => host.audio.playUI(id, v ?? 0.6) });
    w.stationWindow = makeStationWindow(host, w);
    w.toasts = new ToastUI();
    w.dialogue = new DialogueUI({
      pilot: host.pilot, send: (m) => host.network.send(m), sound: (id, v) => host.audio.playUI(id, v ?? 0.6),
      track: (id) => w.quests.track(id), toast: (t, k) => w.toasts.show(t, k),
    });
    w.guide = new GuideUI();
    w.bossUI = new BossUI(host.state, (id, v) => host.audio.playUI(id, v ?? 0.7));
    w.quickBar = new QuickBar(host.pilot, (m) => host.network.send(m), (id, v) => host.audio.playUI(id, v ?? 0.5));
    w.autopilot = new Autopilot({
      state: host.state,
      tuning: shipTuning as ShipTuning,
      accel: () => host.shipClient.localAccel(),
      boostFactor: () => host.shipClient.localBoostFactor(),
      energy: () => host.state.boostFuel,
      jumpPhase: () => host.shipClient.localJump().phase,
      jumpReach: () => host.shipClient.jumpReach(),
      objective: () => host.objective(),
      memberSystem: (id) => w.social?.party.members.find((m) => m.eid === id)?.system,
      interact: () => host.network.send({ type: 'interact' }),
      arrived: (_d, station) => {
        w.context?.arrived();
        host.audio.playUI('ui_open', 0.5);
        if (station) {
          host.showSystemMessage(`Autopilot: arrived at ${station}`, '#86efac');
          if (!host.stationOpen) host.shipClient.onKey('KeyH');
        }
      },
      message: (text, color) => host.showSystemMessage(text, color),
      lead: () => host.state.inputDelayTicks,
      drive: () => {
        const ship = host.shipClient.myShip(), me = host.state.entities.get(host.state.playerId);
        if (!ship || !me) return null;
        const jt = jumpTuning(shipTuning as ShipTuning), cooldown = ship.derived.jumpCooldown || jt.cooldownTicks;
        const j = host.shipClient.localJump();
        const cool = j.phase === 'ready' ? 0 : j.phase === 'cooldown' ? (1 - j.progress) * cooldown : cooldown;
        return { range: jumpRange(ship.derived, jt), cooldown, cool, primed: me.jumpPrime ?? 0 };
      },
    });
    w.quests.onAutopilot = () => host.toggleAutopilotToObjective();
    w.context = new ContextActions({
      state: host.state,
      systems: (systemsDataForMenu as unknown as { systems: StarSystemData[] }).systems,
      system: () => host.currentSystem(),
      cursor: () => ({ x: host.input.mouseX, y: host.input.mouseY }),
      screenToWorld: (x, y) => host.renderer.screenToWorld(x, y),
      worldToScreen: (x, y) => host.renderer.worldToScreen(x, y),
      zoom: () => host.renderer.getZoom(),
      shipRadius: (id) => host.shipClient.store.get(id)?.derived.radius ?? 60,
      people: () => w.peopleUI?.here() ?? [],
      talkRange: TALK_RANGE,
      enabled: () => host.loggedIn && !host.localDead && !host.shipClient.hangarOpen && !host.menu.isOpen && !w.systemMapUI.isOpen
        && !host.stationOpen && !w.inventoryWindow.isOpen && !w.tradeWindow.isOpen && !w.quests.log.isOpen
        && !host.adminPanel?.capturesFlight,
      menuModifier: () => host.input.isKeyDown('KeyZ'),
      autopilot: w.autopilot,
      flyTo: (d, note) => host.flyTo(d, note),
      dock: () => { host.shipClient.onKey('KeyH'); },
      stationInRange: () => host.shipClient.stationInRange()?.name ?? null,
      // (As the X key: the gate card asks first for a system that outclasses you)
      interact: () => { if (host.regionUI.allowInteract()) host.network.send({ type: 'interact' }); },
      planetBelow: () => host.planetBelow(),
      locked: (id) => w.systemMapUI.locked?.(id) ?? null,
      jumpPhase: () => host.shipClient.localJump().phase,
      jumpReach: () => host.shipClient.jumpReach(),
      jumpCool: () => {
        const ship = host.shipClient.myShip(), j = host.shipClient.localJump();
        if (j.phase !== 'cooldown') return 0;
        return ((1 - j.progress) * (ship?.derived.jumpCooldown || jumpTuning(shipTuning as ShipTuning).cooldownTicks)) / 60;
      },
      jumpDanger: () => host.shipClient.jumpDanger(),
      targetId: () => w.targetUI.target,
      setTarget: (id) => w.targetUI.set(id),
      inspect: (id) => w.infoPanel.inspect(id),
      partyMate: (id) => w.social.isMember(id),
      invite: (id) => w.social.invite(id),
      trade: (id) => host.network.send({ type: 'tradeRequest', id }),
      ping: (x, y, kind, target) => host.network.send({ type: 'mapPing', x, y, kind, target }),
      wreck: () => { const w = host.wreck; return w && w.system === host.state.systemId && w.until > Date.now() ? { x: w.x, y: w.y } : null; },
      message: (t, c) => host.showSystemMessage(t, c),
      sound: (id) => host.audio.playUI(id, 0.5),
    });
    w.social = new SocialUI({
      state: host.state,
      send: (m) => host.network.send(m),
      sound: (id, v) => host.audio.playUI(id, v ?? 0.6),
      flyTo: (d) => host.flyTo(d),
      message: (t, c) => host.showSystemMessage(t, c),
      chatTo: (name) => host.chatTo(name),
      friendsOnline: (n) => host.friendsOnline(n),
      openTab: (tab) => w.hub.open(tab),
    });
    // The side panel: its tabs in order (each its own module, ui/hub/tabs/)
    w.hub = new HubPanel({
      player: () => host.state.playerName || '',
      column: () => {
        const c = w.cargoPanel.column();
        return {
          floor: c.floor, cargoMin: c.min, cargoTop: c.top, left: c.left, width: c.width,
          ceiling: Math.max(w.pilotHud.bottom(), w.social.hudBottom()) + 8,
          lift: w.pilotHud.top() || 16,
        };
      },
      relayoutCargo: () => w.cargoPanel.relayout(),
      sound: (id, v) => host.audio.playUI(id, v ?? 0.5),
    });
    w.cargoPanel.onPlace = () => w.hub.position();
    w.hub.register(socialTab(w.social));
    w.hub.register(partyTab(w.social));
    w.hub.register(pilotTab({
      pilot: () => host.pilotInfo(),
      ship: () => host.shipClient.menuShipInfo(),
      dockableStation: () => host.shipClient.dockableStationName(),
      dock: () => { host.shipClient.onKey('KeyH'); },
      keyName: (a) => boundKeyName(a, settings.data.bindings),
    }));
    w.hub.register(componentsTab(w.componentGuide));
    w.hub.register(fabTab());
    // (With the system map open, the cursor is the map's)
    const cursorWorld = () => w.systemMapUI?.aimWorld() ?? host.renderer.screenToWorld(host.input.mouseX, host.input.mouseY);
    const shipRadius = (id: number) => host.shipClient.store.get(id)?.derived.radius ?? 60;
    w.infoPanel = new InfoPanel({
      state: host.state, send: (m) => host.network.send(m), cursorWorld,
      worldToScreen: (x, y) => host.renderer.worldToScreen(x, y), zoom: () => host.renderer.getZoom(),
      radius: shipRadius, inParty: (id) => w.social.isMember(id), itemName: (id) => host.pilot.econ.items.name(id),
      myRating: () => host.shipClient.myRating(), target: () => w.targetUI.target, belowHeight: () => w.targetUI.panelHeight,
    });
    w.tradeWindow = new TradeWindow(host.pilot, (m) => host.network.send(m), (id) => host.audio.playUI(id, 0.5));
    w.targetUI = new TargetUI(host.state, (m) => host.network.send(m), (x, y) => host.renderer.worldToScreen(x, y), () => host.renderer.getZoom(),
      shipRadius, cursorWorld, (id) => host.audio.playUI(id, 0.4), () => host.shipClient.myRating());
    w.buildSites = new BuildSites(host.renderer.getEffectLayer(), host.state);
    w.opsUI = new OpsUI(host.state, (x, y) => host.renderer.worldToScreen(x, y), () => host.renderer.getZoom(), {
      abandon: (id) => w.quests.abandon(id),
      leader: () => (w.social?.inParty() ? w.social.party.members.some((m) => m.leader && m.eid === host.state.playerId) : null),
    });
    w.ribbonPopup = new RibbonPopup((id) => host.audio.playUI(id, 0.6));
    w.pingUI = new PingUI(host.state, (m) => host.network.send(m), (x, y) => host.renderer.worldToScreen(x, y), cursorWorld,
      () => host.renderer.getZoom(), (id) => host.audio.playUI(id, 0.5));
    w.tutorialUI = makeTutorialUI(host, w);
    w.killFeedUI = new KillFeedUI(uiOverlay);
    w.playerStatsUI = new PlayerStatsUI(uiOverlay);
    w.systemMapUI = new SystemMapUI(uiOverlay, host.state);
    w.systemMapUI.onFlyTo = (dest) => host.flyTo(dest);
    w.systemMapUI.wreck = () => (host.wreck && host.wreck.until > Date.now() ? host.wreck : null);
    w.systemMapUI.jump = () => ({ aiming: host.shipClient.jumpAiming(), phase: host.shipClient.localJump().phase, reach: host.shipClient.jumpReach() });
    w.systemMapUI.autoTarget = () => w.autopilot.heading();
    w.systemMapUI.autoRoute = () => w.autopilot.routeView();
    w.systemMapUI.onVisibleChange = (open) => host.network.send({ type: 'mapView', open });
    // Zoom is one continuous range: flight, then the system map, then the galaxy
    w.systemMapUI.flightMinScale = host.input.minZoom;
    host.input.onZoomPastMin = () => {
      if (!host.loggedIn || w.systemMapUI.isOpen || host.shipClient.hangarOpen || host.menu.isOpen) return;
      w.systemMapUI.showFromFlight(host.input.zoom * host.jumpZoom);
      host.audio.playUI('ui_open', 0.4);
    };
    w.systemMapUI.onZoomIntoFlight = (scale) => {
      host.input.zoom = host.input.targetZoom = Math.max(host.input.minZoom, scale);
      host.audio.playUI('ui_close', 0.4);
    };
    w.peopleUI = new PeopleUI(host.state, (x, y) => host.renderer.worldToScreen(x, y), () => w.quests.people);
    w.navMarkers = new NavMarkersUI(host.state, (x, y) => host.renderer.worldToScreen(x, y), () => host.objective(),
      () => [...host.worldEvents.values()].filter((e) => e.system === host.state.systemId).concat(host.objectives.markers(host.state.systemId), host.wreckMarker(), host.siegeMarkers()),
      () => w.social.others().filter((m) => m.alive && m.system === host.state.systemId).map((m) => {
        const e = host.state.entities.get(m.eid);
        return { name: m.name, x: e?.renderX ?? m.x, y: e?.renderY ?? m.y };
      }),
      () => {
        // (Not twice: the job's own marker already points at its site)
        const o = host.objective();
        // People out here who want you
        const people = (w.peopleUI?.here() ?? []).filter((p) => p.mark).map((p) => ({ name: `${p.mark === 'offer' ? '! ' : '▸ '}${p.name}`, x: p.x!, y: p.y! }));
        return [...w.opsUI.markers(), ...w.pingUI.markers(), ...people].filter((m) => !o || o.x === undefined || o.y === undefined || Math.hypot(m.x - o.x, m.y - o.y) > 300);
      });
    w.farMarkers = new FarZoomMarkers(host.state, (x, y) => host.renderer.worldToScreen(x, y), () => host.renderer.getZoom(), () => w.social.memberIds());
    w.chatBubbles = new ChatBubbles({
      state: host.state, map: w.systemMapUI,
      toScreen: (x, y, out) => host.renderer.worldToScreenInto(x, y, out), zoom: () => host.renderer.getZoom(),
      shipRadius: (id) => host.shipClient.store.get(id)?.derived.radius ?? 60,
    });
    w.systemMapUI.party = () => w.social.others();
    w.systemMapUI.myRating = () => host.shipClient.myRating();
    w.systemMapUI.myShip = () => host.shipClient.myShip()?.derived ?? null;
    w.systemMapUI.locked = (id) => {
      const r = (questsData as unknown as QuestsFile).restricted[id];
      if (!r || host.pilot.profile?.licences.includes(r.licence ?? id)) return null;
      return { name: r.name, hint: r.hint };
    };
    w.systemMapUI.pings = () => w.pingUI.markers();
    w.gunRangeHud = makeGunRangeHud(host, w);
    w.systemMapUI.onPing = (x, y) => w.pingUI.pingAt(x, y);

  return w;
}
