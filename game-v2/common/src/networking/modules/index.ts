// Export all network modules from a single entry point
export { 
  NetworkModule, 
  ModuleCategory, 
  NetworkModuleRegistry, 
  moduleRegistry, 
  createModule 
} from './NetworkModule.js';

export { InputModule, InputData, createEmptyInput, inputsEqual } from './InputModule.js';
export { TransformModule, TransformData, createDefaultTransform } from './TransformModule.js';
export { VelocityModule, VelocityData, createZeroVelocity } from './VelocityModule.js';
export { OrbitModule, createNoOrbit } from './OrbitModule.js';
export { HealthModule, HealthData, createHealth, isAlive, healthPercent } from './HealthModule.js';
export { AIModule, AIData, NetAIState, NetAIStateValue, createIdleAI, getAIStateName } from './AIModule.js';
