import { runPartContract } from '../contract.js';

runPartContract('clamp', {
  parts: [
    { uid: 63, piece: 'sq', fn: 'docking_clamp', material: 'alloy', x: 2, y: 0, rot: 0, flip: false, facing: 'E' },
  ],
});
