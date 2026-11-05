// One seeded random stream for the whole simulation, so a save plays out the
// same way every time it is loaded. The stream's position is saved with the game.

let state = 1;

export function seedRng(n: number): void {
  state = (n >>> 0) || 1;
}

/** Where the stream is now; stored in the save so a reload continues it. */
export function rngState(): number {
  return state;
}

/** 0 ≤ x < 1, like Math.random (mulberry32). */
export function random(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A separate generator from a seed, for things decided before the game starts. */
export function seeded(n: number): () => number {
  let s = (n >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
