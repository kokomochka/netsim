// Artifact build only: Pixi is inlined by build.mjs as window.PIXI,
// and this module stands in for the 'pixi.js' import (see build.mjs).
const P = (globalThis as unknown as { PIXI: Record<string, unknown> }).PIXI;
export const Application = P.Application;
export const Container = P.Container;
export const Graphics = P.Graphics;
export const GraphicsContext = P.GraphicsContext;
export const Text = P.Text;
export const Circle = P.Circle;
