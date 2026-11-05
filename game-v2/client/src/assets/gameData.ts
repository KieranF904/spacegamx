/**
 * Fingerprints of the bundled game data that generated assets are drawn from, as part of their keys (assetCache.ts):
 * an edited item or piece is never shown from a picture of the old one.
 */
import items from '../../../data/items.json';
import pieces from '../../../data/ships/pieces.json';
import functions from '../../../data/ships/functions.json';
import materials from '../../../data/ships/materials.json';
import models from '../../../data/ships/models.json';
import { hashOf } from './assetCache';

let parts: string | null = null;
/** What item icons and part pictures are drawn from: the items, and the ship parts' pieces, functions, materials and models */
export const pictureData = (): string => (parts ??= hashOf([items, pieces, functions, materials, models]));
