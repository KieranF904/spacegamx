import { describe, it, expect } from 'vitest';
import type { ClientMessage } from '@space-game/common';
import { BackupPicker, backupLabel } from './BackupPicker';

describe('the backup picker', () => {
  it('the starter is first and the default; a pick on offer goes with the respawn, one not on offer sends none', () => {
    const k = new BackupPicker();
    const sent: ClientMessage[] = [];
    k.bind((m) => sent.push(m));
    k.set({ type: 'backups', options: [{ slot: -1, name: 'Sparrow T', built: 12, parts: 12 }, { slot: 2, name: 'Little Sparrow', built: 9, parts: 11 }], lost: 'Prospector' });
    expect(k.choice()).toEqual({});
    k.respawn(2);
    expect(sent.at(-1)).toEqual({ type: 'respawn', backup: 2 });
    expect(k.choice()).toEqual({ backup: 2 });
    k.respawn(5);
    expect(sent.at(-1)).toEqual({ type: 'respawn' });
    // (A new death: the starter again until they pick)
    k.set({ type: 'backups', options: [{ slot: -1, name: 'Sparrow T', built: 12, parts: 12 }] });
    expect(k.choice()).toEqual({});
    expect(backupLabel({ slot: -1, name: 'Sparrow T', built: 12, parts: 12 })).toBe('Sparrow T (starter, free)');
    expect(backupLabel({ slot: 2, name: 'Little Sparrow', built: 9, parts: 11 })).toBe('Little Sparrow · 9/11 parts');
  });
});
