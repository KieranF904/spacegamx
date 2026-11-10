/** Grid cells packed as one number (a cell's integer coordinates): x and y each offset into 0..4095 */
const OFF = 2048, SPAN = 4096;
export const cellKey = (x: number, y: number): number => (x + OFF) * SPAN + (y + OFF);
export const cellOf = (k: number): [number, number] => [Math.floor(k / SPAN) - OFF, (k % SPAN) - OFF];
