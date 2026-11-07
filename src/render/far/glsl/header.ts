// Common GLSL header for the far-field shaders (shared chunks only up to sv_lighting).
export const FAR_HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
#include <sv_common>
#include <sv_saturn>
#include <sv_ringProfile>
#include <sv_lighting>
`;
