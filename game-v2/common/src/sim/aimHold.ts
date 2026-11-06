/**
 * The held aim angle: a pilot's aim goes to the other ends only when it changes what the ship does.
 *
 * Every tick a pilot's ship is stepped on its raw aim (its input's q), as it always was. Beside it the step works out
 * whether its *held* aim (the aim it was applied at last tick, the q its control row last carried: SimInput.heldQ) would
 * have done exactly the same, bit for bit:
 *   - the flight (ships/flight.ts stepFlight, FlightResult.aimHeld): the same spin out of the turn (steerSpin's ask,
 *     then the torque caps: flat out, or held to the torque either way, a different aim turns the same), the same jump
 *     counter (charging, the drive waits on the nose being aimed: aimed either way, or not), no burn starting along the
 *     aim; at the helm the aim steers nothing;
 *   - the guns (ships/guns.ts stepGuns, GunOrders.heldAim, GunStep.aimHeld): every turret's and fixed gun's aim
 *     (its offset and whether it may fire) the same, on any tick the trigger is down, held or let go, a semi-automatic
 *     click is waiting, or anything fires. Idle, a turret's look is drawing only (nothing carries from it to the next
 *     trigger-down, and the lanes' hash leaves it out): it never keeps the aim from being held.
 * Both the same, the tick's *applied* aim (SimShipState.ctl.q, what replicas and gun lanes fly) stays the held one;
 * otherwise it is the raw one. Since the held aim is taken only where it does exactly what the raw one does, a ship
 * flown on its applied aims (every replica, shadow and lane) goes exactly where it went on its raw ones: nothing it does
 * changes, only which aim values are sent (a pilot's control row gets a new aim only when its applied aim changes).
 *
 * Who runs it: whoever has the raw aim, which is the pilot's own ship on the server (bridge/flight.ts stepMovement, then
 * weapons.ts stepWeapons for the guns' half) and its own client (sim/ownStep.ts stepOwnShip, from client OwnTick: its
 * own state hash carries the applied aim, so both ends work it out alike). Everyone else is sent the applied aim and
 * flies it as it is (heldQ absent).
 */

/** The tick's applied aim: the held one where the flight and the guns would have done the same on it, else the raw one */
export function appliedAimQ(rawQ: number, heldQ: number | undefined, flightHeld: boolean, gunsHeld: boolean): number {
  return heldQ !== undefined && flightHeld && gunsHeld ? heldQ : rawQ;
}

/** How often a pilot's aim was held (counted where the rule runs on the authority) */
export interface AimHoldStats {
  /** Pilot ticks stepped with a held aim known */
  ticks: number;
  /** ...whose raw aim was off the held one (the aim moved since it was last applied) */
  moved: number;
  /** ...of those, held all the same (the flight and the guns did the same on it): no aim to send */
  held: number;
  /** ...of those, taken because the flight differed, or the guns did */
  flight: number;
  guns: number;
}

export function newAimHoldStats(): AimHoldStats {
  return { ticks: 0, moved: 0, held: 0, flight: 0, guns: 0 };
}
