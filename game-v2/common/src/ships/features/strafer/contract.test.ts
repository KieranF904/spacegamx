import { runPartContract } from '../contract.js';

runPartContract('strafer', {
  parts: [
    { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' },
    { uid: 61, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: -2, y: 0, rot: 0, flip: false, facing: 'W' },
  ],
});
