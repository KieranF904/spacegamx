/**
 * @contract client.app.frame-gate
 * owns:       holding the server's messages, in order, while something a message needs is still loading (a system's rock)
 * needs:      @space-game/common ServerMessage, a deliver/frameEnd pair (Game's handlers), a hold test per message (rendering/terrainData.ts terrainHold)
 * invariants: messages and frame ends come out in the order they went in, held or not — client/src/rendering/terrainLoad.test.ts
 *             a message is handled only once what it waits for is in — client/src/rendering/terrainLoad.test.ts
 * extend:     something else a message must wait for is one more check in the hold test
 */

import type { ServerMessage } from '@space-game/common';

/**
 * Between the transport and Game's message handlers: a message that has to wait (a join or system change to a system
 * whose rock is still a chunk away) holds it and everything after it, frame ends too, until the wait is over; then
 * they all go through as they came. Nothing waits when nothing's loading: the hold test answers null and the message
 * goes straight on, so this adds nothing to a frame in play.
 */
export class FrameGate {
  /** What's waiting, in order (null: a frame's end); null when nothing's held */
  private held: (ServerMessage | null)[] | null = null;

  constructor(
    private readonly deliver: (msg: ServerMessage) => void,
    private readonly frameEnd: () => void,
    private readonly holdFor: (msg: ServerMessage) => Promise<void> | null,
  ) {}

  /** Nothing's held */
  get open(): boolean {
    return !this.held;
  }

  message(msg: ServerMessage): void {
    if (this.held) { this.held.push(msg); return; }
    const wait = this.holdFor(msg);
    if (!wait) { this.deliver(msg); return; }
    this.hold([msg], wait);
  }

  end(): void {
    if (this.held) this.held.push(null);
    else this.frameEnd();
  }

  /** The connection went: what it was holding is dropped (the server tells a new one everything afresh) */
  drop(): void {
    if (this.held) this.held.length = 0;
  }

  private hold(queue: (ServerMessage | null)[], wait: Promise<void>): void {
    const held = (this.held = queue);
    const go = () => { if (this.held === held) this.release(); };
    wait.then(go, go);
  }

  /** Lets what's held through, until a message has to wait again (that one and the rest are held anew) */
  private release(): void {
    const queue = this.held!;
    this.held = null;
    for (let i = 0; i < queue.length; i++) {
      const msg = queue[i];
      // (One failing doesn't lose the rest, as NetworkManager.deliverFrame)
      try {
        if (msg === null) { this.frameEnd(); continue; }
        const wait = this.holdFor(msg);
        if (wait) { this.hold(queue.slice(i), wait); return; }
        this.deliver(msg);
      } catch (e) {
        console.error('held server message failed', e);
      }
    }
  }
}
