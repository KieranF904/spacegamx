import { runPartContract } from '../contract.js';

runPartContract('machines', {
  parts: [
    { uid: 60, piece: 'rect2', fn: 'fabricator_field', material: 'alloy', x: 3, y: 0, rot: 0, flip: false },
    { uid: 61, piece: 'sq', fn: 'refiner_field', material: 'alloy', x: -3, y: 0, rot: 0, flip: false },
  ],
});
