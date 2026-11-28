/**
 * Small deterministic helpers shared by the browser and the Node tooling.
 * FNV-1a 32-bit is used for texture digests: fast, dependency-free and stable
 * across runtimes for the same byte sequence.
 */

export function fnv1aBytes(bytes: Uint8Array | Uint8ClampedArray, seed = 0x811c9dc5): string {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hex32(hash);
}

export function fnv1aString(text: string): string {
  return fnv1aBytes(new TextEncoder().encode(text));
}

export function fnv1aCombine(a: string, b: string): string {
  return fnv1aString(`${a}|${b}`);
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/** FNV digest of a texture's RGBA buffer. */
export function textureDigest(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): string {
  return `${fnv1aBytes(rgba)}-${width}x${height}`;
}
