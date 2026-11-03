/** Which way an offset points, as a compass word (screen up is north): for pads and fronts round the bastion */
export function compass(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 1) return 'centre';
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return names[((k % 8) + 8) % 8];
}
