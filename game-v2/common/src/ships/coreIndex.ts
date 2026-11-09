/** Where the ship's core is (the one part with fn 'core'): its index in the parts list, or -1; the 'core' id lives only here */
export function coreIndex(parts: readonly { fn: string }[] | undefined): number {
  return parts ? parts.findIndex((p) => p.fn === 'core') : -1;
}

/** The core part itself, if the list has one */
export function coreOf<T extends { fn: string }>(parts: readonly T[]): T | undefined {
  return parts.find((p) => p.fn === 'core');
}
