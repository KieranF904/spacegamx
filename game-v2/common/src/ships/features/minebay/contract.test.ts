import { runPartContract } from '../contract.js';

runPartContract('minebay', {
  parts: [
    { uid: 62, piece: 'rect2', fn: 'mine_bay', material: 'steel', x: 0, y: 2, rot: 0, flip: false, facing: 'S' },
  ],
});
