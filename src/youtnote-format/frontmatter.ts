import { CURRENT_FORMAT_VERSION, PreservedFrontmatter } from './types';

export interface ExtractedFrontmatter {
    raw: string;
    body: string;
}

export function extractFrontmatter(source: string): ExtractedFrontmatter {
    const lines = source.split('\n');
    if (lines[0].trim() !== '---') {
        return { raw: '', body: source };
    }
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            const raw = lines.slice(0, i + 1).join('\n');
            return { raw, body: source.slice(raw.length) };
        }
    }
    return { raw: '', body: source };
}

export interface FormatDeclaration {
    count: number;
    rawValue: string;
}

const FORMAT_KEY_PATTERN = /^youtnote-format-version\s*:\s*(.*)$/;

export function findFormatDeclarations(frontmatter: PreservedFrontmatter): FormatDeclaration {
    if (!frontmatter.raw) {
        return { count: 0, rawValue: '' };
    }
    const lines = frontmatter.raw.split('\n').slice(1, -1);
    let count = 0;
    let rawValue = '';
    for (const line of lines) {
        if (/^\s/.test(line) || line.trim() === '') continue;
        const match = line.match(FORMAT_KEY_PATTERN);
        if (match) {
            count++;
            if (count === 1) {
                rawValue = match[1].trim();
            }
        }
    }
    return { count, rawValue };
}

export function withFormatVersion(frontmatter: PreservedFrontmatter, version: number = CURRENT_FORMAT_VERSION): string {
    const declaration = `youtnote-format-version: ${version}`;

    if (!frontmatter.raw) {
        return ['---', 'youtnote: true', declaration, '---'].join('\n');
    }

    const lines = frontmatter.raw.split('\n');
    const inner = lines.slice(1, -1);

    let replaced = false;
    let hasYoutnoteKey = false;
    let youtnoteKeyIndex = -1;
    const next: string[] = [];
    for (let i = 0; i < inner.length; i++) {
        const line = inner[i];
        const isTopLevel = line.trim() !== '' && !/^\s/.test(line);
        if (isTopLevel && FORMAT_KEY_PATTERN.test(line)) {
            if (!replaced) {
                next.push(declaration);
                replaced = true;
            }
            continue;
        }
        if (isTopLevel && /^youtnote\s*:/.test(line)) {
            hasYoutnoteKey = true;
            youtnoteKeyIndex = next.length;
        }
        next.push(line);
    }

    if (!replaced) {
        const insertAt = hasYoutnoteKey ? youtnoteKeyIndex + 1 : 0;
        next.splice(insertAt, 0, declaration);
    }

    return [lines[0], ...next, lines[lines.length - 1]].join('\n');
}
