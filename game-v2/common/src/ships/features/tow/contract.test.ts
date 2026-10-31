import { runPartContract } from '../contract.js';

runPartContract('tow', {
  parts: [{ uid: 70, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -3, y: 0, rot: 0, flip: false, facing: 'W' }],
});
