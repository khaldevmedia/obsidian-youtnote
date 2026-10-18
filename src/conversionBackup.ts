export function getLegacyBackupPath(filePath: string, index: number = 1): string {
    const stem = filePath.replace(/\.md$/i, '');
    return `${stem} - legacy backup${index === 1 ? '' : ` ${index}`}.md`;
}
