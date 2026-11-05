/**
 * Main Entry Point
 */

import { Game } from './Game';

// Wait for DOM
document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('game-container');
  if (!container) {
    console.error('Game container not found');
    return;
  }
  
  // Proto mode (npm run proto): in-process server, loaded lazily so normal builds don't bundle it
  if (new URLSearchParams(window.location.search).has('proto')) {
    const { startProto } = await import('./proto/protoMain');
    await startProto(container);
    return;
  }
  
  const game = new Game(container);
  await game.init();
  game.start();
  // Dev builds only: reachable from the devtools console
  if ((import.meta as any).env?.DEV) (window as any).__game = game;
});
