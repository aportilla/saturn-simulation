// Registers the shared GLSL chunks with three.js so any ShaderMaterial / RawShaderMaterial can use
//   #include <sv_common>  #include <sv_saturn>  #include <sv_ringProfile>  #include <sv_ringStructure>
//   #include <sv_lighting>  #include <sv_ringLod>  #include <sv_wakes>
// (include order: common, saturn, ringProfile, ringStructure, lighting, ringLod, wakes — later chunks depend on
// earlier ones; sv_ringStructure needs sv_common + sv_ringProfile and is the lookup every main-ring tau goes through).
import { ShaderChunk } from 'three';
import common from './common.glsl?raw';
import saturn from './saturn.glsl?raw';
import ringProfile from './ringProfile.glsl?raw';
import ringStructure from './ringStructure.glsl?raw';
import lighting from './lighting.glsl?raw';
import ringLod from './ringLod.glsl?raw';
import wakes from './wakes.glsl?raw';

let registered = false;
export function registerShaderChunks(): void {
  if (registered) return;
  const sc = ShaderChunk as unknown as Record<string, string>;
  sc['sv_common'] = common;
  sc['sv_saturn'] = saturn;
  sc['sv_ringProfile'] = ringProfile;
  sc['sv_ringStructure'] = ringStructure;
  sc['sv_lighting'] = lighting;
  sc['sv_ringLod'] = ringLod;
  sc['sv_wakes'] = wakes;
  registered = true;
}

/** Standard header for a GLSL3 RawShaderMaterial fragment/vertex shader using all shared chunks. */
export const SV_HEADER_ALL = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#include <sv_common>
#include <sv_saturn>
#include <sv_ringProfile>
#include <sv_ringStructure>
#include <sv_lighting>
#include <sv_ringLod>
#include <sv_wakes>
`;
