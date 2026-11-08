import { runPartContract } from '../contract.js';

runPartContract('zoneshield', {
  parts: [{ uid: 70, piece: 'sq', fn: 'shield_spark_wall', material: 'alloy', x: -2, y: 0, rot: 0, flip: false, facing: 'W' }],
});
