/**
 * Main Entry Point
 */

// Pixi builds its uniform and shader-sync code with new Function() by default; this swaps in versions that don't, so the
// page's Content-Security-Policy (deploy/vps/nginx-spacegame-game.conf) needs no 'unsafe-eval'. Loads before Pixi starts.
import 'pixi.js/unsafe-eval';
import { Game } from './Game';

// Wait for DOM
document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('game-container');
  if (!container) {
    console.error('Game container not found');
    return;
  }
  
  const game = new Game(container);
  await game.init();
  game.start();
  // Dev builds only: reachable from the devtools console
  if ((import.meta as any).env?.DEV) (window as any).__game = game;
});
