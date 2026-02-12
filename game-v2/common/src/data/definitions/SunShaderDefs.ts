// @ts-ignore - import assertion syntax varies across TS versions
import sunShaderDefsJson from './sun-shader-defs.json';

export interface ShaderParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface SunShaderStyleDef {
  id: string;
  label: string;
  params: ShaderParamDef[];
}

export interface SunShaderDefs {
  sunStyles: SunShaderStyleDef[];
  coronaStyles: SunShaderStyleDef[];
}

export const sunShaderDefs = sunShaderDefsJson as SunShaderDefs;
export const sunStyles = sunShaderDefs.sunStyles;
export const coronaStyles = sunShaderDefs.coronaStyles;

export type SunStyleId = (typeof sunShaderDefsJson.sunStyles)[number]['id'];
export type CoronaStyleId = (typeof sunShaderDefsJson.coronaStyles)[number]['id'];

export default sunShaderDefs;
