import { describe, expect, it } from 'vitest';
import { getLegacyBackupPath } from './conversionBackup';

describe('getLegacyBackupPath', () => {
    it.each<[string, number | undefined, string]>([
        ['a.md', undefined, 'a - legacy backup.md'],
        ['a.md', 1, 'a - legacy backup.md'],
        ['a.md', 2, 'a - legacy backup 2.md'],
        ['a.md', 10, 'a - legacy backup 10.md'],
        ['folder/a.md', 1, 'folder/a - legacy backup.md'],
        ['nested dir/my file.md', 3, 'nested dir/my file - legacy backup 3.md'],
        ['UPPER.MD', 1, 'UPPER - legacy backup.md'],
        ['no-extension', 1, 'no-extension - legacy backup.md'],
        ['weird.md.md', 2, 'weird.md - legacy backup 2.md'],
    ])('maps %s index %s to %s', (path, index, expected) => {
        expect(getLegacyBackupPath(path, index)).toBe(expected);
    });
});
