/**
 * What the Refiner and Fabricator tabs both show of a machine: its name and switch, its status line and progress (the
 * job as it stands now, from the machine's own predicted clock: never sent), and its power (its part's draw while it
 * works, and the share it is getting now). The core's own machine draws nothing.
 */
import { MACHINE_FAB, MACHINE_REF, jobFraction, portsMachinePart, type MachineKind, type MachineView, type ShipState, type Charge, type ClientMessage } from '@space-game/common';
import { fieldBridge } from '../../../ships/field/bridge';
import { fieldClient, machineJob } from '../../../ships/field/fieldState';
import { machineName, machineStatus } from '../../../ships/field/fieldText';
import { meter, row, note, num, esc } from './view';

export function machineHead(kind: MachineKind, ship: ShipState | null, charge: Charge): { m: MachineView | undefined; html: string } {
  const m = fieldClient.machine(kind), deps = fieldBridge.deps;
  if (!m || !deps) return { m, html: note('No word from your machines yet.') };
  const job = machineJob(m, deps.clocks());
  const status = machineStatus(m, job, (id) => deps.econ.items.name(id));
  const warn = m.on && !!m.blocked && m.blocked !== 'idle';
  let html = `<div class="sgsw-sec">${esc(machineName(m))}<span><button class="sgsw-mini${m.on ? ' on' : ''}" data-act="switch" title="Switch it on or off (it draws power only while it works)">${m.on ? 'On' : 'Off'}</button></span></div>`;
  html += `<div class="sgsw-row"><span class="nm ${warn ? 'sgsw-warn' : ''}">${esc(status)}</span>${job ? meter(jobFraction(job)) : ''}${job ? `<button class="sgsw-mini" data-act="cancel" title="Call this job off: its inputs go back to the hold">×</button>` : ''}</div>`;
  // Power: the part's draw while it works, and what it is getting now (PortsState.sat)
  const L = ship?.derived.ports;
  const part = L ? portsMachinePart(L, kind === 'fabricator' ? MACHINE_FAB : MACHINE_REF) : -1;
  if (L && part >= 0) {
    const draw = (L.rate[part] * 60) / 256, sat = charge.e ? charge.e.sat[part] / 255 : 1;
    html += row('Power', m.drawing ? `${num(draw)}/s${sat < 0.99 ? ` · <span class="sgsw-warn">getting ${Math.round(sat * 100)}%</span>` : ''}` : `${num(draw)}/s while working · <span class="sgsw-dim">idle</span>`);
  } else html += row('Power', '<span class="sgsw-dim">none: the core\'s own works slowly, unpowered</span>');
  return { m, html };
}

/** The machine's switch and cancel buttons (data-act "switch" / "cancel") */
export function machineAct(kind: MachineKind, act: string, send: (m: ClientMessage) => void): boolean {
  const m = fieldClient.machine(kind);
  if (act === 'switch') { send({ type: 'machine', kind, on: !(m?.on ?? false) }); return true; }
  if (act === 'cancel' && m?.job) { send({ type: 'fieldCancel', kind, job: m.job.id }); return true; }
  return false;
}

