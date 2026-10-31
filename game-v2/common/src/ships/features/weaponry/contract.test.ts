import { runPartContract } from '../contract.js';

// (Weapon-kind feature: no part of its own; its roles are picked by weapon models' tuning)
runPartContract('weaponry');
