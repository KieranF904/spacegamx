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
  
  const game = new Game(container);
  await game.init();
  game.start();
});
