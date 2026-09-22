import { extractFrontmatter, findFormatDeclarations } from './frontmatter';
import { CURRENT_FORMAT_VERSION, FormatDetection, LEGACY_FORMAT_VERSION } from './types';

export function detectYoutnoteFormat(source: string): FormatDetection {
    const { raw } = extractFrontmatter(source);
    const declarations = findFormatDeclarations({ raw });

    if (declarations.count > 1) {
        return { kind: 'malformed-version', rawValue: declarations.rawValue };
    }

    if (declarations.count === 0) {
        return { kind: 'legacy', version: LEGACY_FORMAT_VERSION };
    }

    const rawValue = declarations.rawValue;
    const value = rawValue.replace(/\s+#.*$/, '').trim();

    if (!/^\d+$/.test(value)) {
        return { kind: 'malformed-version', rawValue };
    }

    const version = Number(value);
    if (!Number.isSafeInteger(version) || version <= 0) {
        return { kind: 'malformed-version', rawValue };
    }
    if (version === LEGACY_FORMAT_VERSION) {
        return { kind: 'legacy', version: LEGACY_FORMAT_VERSION };
    }
    if (version === CURRENT_FORMAT_VERSION) {
        return { kind: 'supported', version: CURRENT_FORMAT_VERSION };
    }
    if (version > CURRENT_FORMAT_VERSION) {
        return { kind: 'unsupported-version', version, maxSupported: CURRENT_FORMAT_VERSION };
    }
    return { kind: 'malformed-version', rawValue };
}
