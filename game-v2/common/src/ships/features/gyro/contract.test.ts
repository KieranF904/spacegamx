import { runPartContract } from '../contract.js';

runPartContract('gyro', {
  parts: [
    { uid: 60, piece: 'sq', fn: 'utility_gyro', material: 'alloy', x: 3, y: 0, rot: 0, flip: false },
    { uid: 61, piece: 'block2', fn: 'utility_heavy_gyro', material: 'titanium', x: -3, y: -1, rot: 0, flip: false },
  ],
});
