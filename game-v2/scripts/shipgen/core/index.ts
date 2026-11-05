// Ship generator core: pure (no network). Everything is derived from the game's live code and data; data/shipgen/roles.json is the only taste.
export { type ShipgenContext, DATA_DIR, loadContext, readCatalogFiles } from './context';
export { type CodeDef, type Legend, type LegendEntry, type TierBand, buildLegend, legendFor, legendText, partInBand, pieceWords, allocateCode } from './legend';
export { type PartPower, type PowerRole, partPower } from './partPower';
export { type PieceShapes, type ShapeClass, allShapes, pieceShapes, shapeOfPart, mirrorShape, shapeWords } from './shapes';
export {
  CodeBook, type DecodeResult, type EncodeResult, type GridError, FACING_MARK, blueprintToGrid, gridToBlueprint, gridLines, partKey, partAt,
  mirrorPart, mirrorLeft, mirrorGridLeft, coreAxis2,
} from './grid';
export { type HalfResult, sideOf, halfAxis2, halfOf, mirrorHalf, asymmetricCells } from './mirror';
export { partEntry, blueprintToParts, partsToBlueprint, mergeParts, boxSize } from './partlist';
export { type ShipEnergy, type RunOptions, type RunResult, shipEnergy, runEnergy } from './sim';
export { type DesignScores, designScores } from './scores';
export { type Corner, exposedCorners, silhouetteScore, squareCornerWords, coreLeftEdge, outlineShapes, rowWidths, shipRows } from './silhouette';
export { type CheckResult, type CheckOptions, type CheckError, type ConsumerPower, type PowerReport, type CheckStats, type PartRef, DEFAULT_WEIGHTS, check } from './check';
export { type Role, type RolesFile, type Selector, type SelectorRole, type BriefCheck, loadRoles, findRole, matches, selectorWords, briefCheck, outOfBand, roleCheckOptions } from './roles';
export {
  type Brief, type FeedbackInput, type DesignForm, type PromptOptions, rulesText, rulesShort, shapeSuggestion, shownLegend, withShape, formatText, partsFormatText, mirrorText, designText, briefLegend, briefText,
  systemPrompt, feedbackMessage,
} from './prompt';
export {
  type Concept, type ConceptHint, type SizeClass, CONCEPT_SCHEMA, CONCEPT_TOKENS, classRange, cleanName, conceptBlock, conceptKey, conceptLine, conceptPenalty, conceptRequest, fallbackConcept, outlineFit, outlinePicture, parseConcept, parseOutline,
} from './concept';
