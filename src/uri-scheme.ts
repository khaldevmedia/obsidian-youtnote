import { extractYouTubeId, normalizeYouTubeUrl, parseTimestampInput } from './utils';

/** Maximum total URL length accepted by the handler. */
export const MAX_URL_LENGTH = 2000;
/** Maximum length of the `url` parameter. */
export const MAX_URL_PARAM_LENGTH = 500;
/** Maximum length of the decoded `text` parameter. */
export const MAX_TEXT_LENGTH = 1000;
/** Debounce window in milliseconds. */
export const DEBOUNCE_MS = 500;

/** Valid mode values for the URI scheme. */
export type YoutnoteUriMode = 'new' | 'append' | 'note' | 'general-note';

/** Allowed parameter keys in the URI scheme. */
const ALLOWED_PARAMS = ['url', 'mode', 'timestamp', 'text'];

/** Raw parsed parameters from the URI (before validation). */
export interface ParsedYoutnoteUriParams {
    url?: string | undefined;
    mode?: string | undefined;
    timestamp?: string | undefined;
    text?: string | undefined;
}

/** Result of validating parsed URI parameters. */
export interface ValidatedYoutnoteUriParams {
    valid: boolean;
    error?: string | undefined;
    normalizedUrl?: string | undefined;
    mode: YoutnoteUriMode;
    timestampSec?: number | undefined;
    text?: string | undefined;
}

/**
 * Checks if the raw params object contains any keys other than the allowed ones.
 * 'action' is included by Obsidian and is always allowed.
 * Returns an array of unsupported param names, or empty if all are allowed.
 */
export function getUnsupportedParams(rawParams: Record<string, string>): string[] {
    const allowed = ['action', ...ALLOWED_PARAMS];
    return Object.keys(rawParams).filter(key => !allowed.includes(key));
}

/**
 * Checks if the text starts with a `---` frontmatter marker.
 * Such text is rejected (not stripped) for security reasons.
 */
export function hasLeadingFrontmatter(text: string): boolean {
    return /^\s*---\s*\n?/.test(text);
}

/**
 * Checks if any line of the text would be parsed as a youtnote section marker
 * (video link, timestamp marker, or general-note marker). Such text is rejected
 * because it would corrupt the file structure on the next load.
 */
export function hasStructuralDelimiter(text: string): boolean {
    return text.split('\n').some(rawLine => {
        const line = rawLine.trim();
        if (line === '[general-note](general-note)') return true;
        if (/^\[[\d:]+\]\(timestamp\)/.test(line)) return true;
        const videoMatch = line.match(/^\[(.*?)\]\((.+)\)$/);
        return videoMatch !== null && extractYouTubeId(videoMatch[2]) !== null;
    });
}

/**
 * Validates parsed URI parameters against all safeguards.
 * Returns a validated result (with normalized URL, parsed timestamp, text)
 * or an error message explaining why the params were rejected.
 */
export function validateYoutnoteUriParams(
    params: ParsedYoutnoteUriParams,
    fullUrlLength: number
): ValidatedYoutnoteUriParams {
    // 1. Check total URL length
    if (fullUrlLength > MAX_URL_LENGTH) {
        return {
            valid: false,
            error: `URL is too long (${fullUrlLength} chars). Maximum is ${MAX_URL_LENGTH} chars.`,
            mode: 'new',
        };
    }

    // 2. Validate mode — reject if missing or not in whitelist
    const validModes: YoutnoteUriMode[] = ['new', 'append', 'note', 'general-note'];
    if (!params.mode) {
        return {
            valid: false,
            error: 'Missing required "mode" parameter.',
            mode: 'new',
        };
    }
    if (!validModes.includes(params.mode as YoutnoteUriMode)) {
        return {
            valid: false,
            error: `Invalid mode "${params.mode}". Must be one of: new, append, note, general-note.`,
            mode: 'new',
        };
    }
    const mode = params.mode as YoutnoteUriMode;

    // 3. Validate url param is present
    if (!params.url) {
        return {
            valid: false,
            error: 'Missing required "url" parameter.',
            mode,
        };
    }

    // 4. Check url param length
    if (params.url.length > MAX_URL_PARAM_LENGTH) {
        return {
            valid: false,
            error: `"url" parameter is too long (${params.url.length} chars). Maximum is ${MAX_URL_PARAM_LENGTH} chars.`,
            mode,
        };
    }

    // 5. Validate url resolves to a YouTube ID
    const ytId = extractYouTubeId(params.url);
    if (!ytId) {
        return {
            valid: false,
            error: 'The "url" parameter is not a valid YouTube URL.',
            mode,
        };
    }

    // 6. Normalize the URL
    const normalizedUrl = normalizeYouTubeUrl(params.url);
    if (!normalizedUrl) {
        return {
            valid: false,
            error: 'Failed to normalize the YouTube URL.',
            mode,
        };
    }

    // 7. If mode=note: validate timestamp format (syntax only — duration is
    // validated against the actual video in main.ts after the player loads)
    let timestampSec: number | undefined;
    if (mode === 'note') {
        if (!params.timestamp) {
            return {
                valid: false,
                error: 'Missing required "timestamp" parameter for mode=note.',
                mode,
                normalizedUrl,
            };
        }

        // Pass maxDuration=0 for syntax-only validation (format, negativity).
        // The actual duration check is performed in main.ts once the player
        // loads the video and populates video.durationSec.
        const tsResult = parseTimestampInput(params.timestamp, 0);
        if (tsResult.error) {
            return {
                valid: false,
                error: `Invalid timestamp: ${tsResult.error}`,
                mode,
                normalizedUrl,
            };
        }

        timestampSec = tsResult.seconds;
    }

    // 8. If mode=note or mode=general-note: validate text
    let text: string | undefined;
    if (mode === 'note' || mode === 'general-note') {
        if (!params.text) {
            return {
                valid: false,
                error: `Missing required "text" parameter for mode=${mode}.`,
                mode,
                normalizedUrl,
                timestampSec,
            };
        }

        if (params.text.length > MAX_TEXT_LENGTH) {
            return {
                valid: false,
                error: `"text" parameter is too long (${params.text.length} chars). Maximum is ${MAX_TEXT_LENGTH} chars.`,
                mode,
                normalizedUrl,
                timestampSec,
            };
        }

        // Reject text with leading frontmatter markers (security)
        if (hasLeadingFrontmatter(params.text)) {
            return {
                valid: false,
                error: 'The "text" parameter contains a leading frontmatter marker (---), which is not allowed.',
                mode,
                normalizedUrl,
                timestampSec,
            };
        }

        if (hasStructuralDelimiter(params.text)) {
            return {
                valid: false,
                error: 'The "text" parameter contains a line that would be interpreted as a youtnote section marker (video link, [mm:ss](timestamp), or [general-note](general-note)), which is not allowed.',
                mode,
                normalizedUrl,
                timestampSec,
            };
        }

        text = params.text;
    }

    return {
        valid: true,
        normalizedUrl,
        mode,
        timestampSec,
        text,
    };
}

/**
 * Returns true if two timestamps are within the debounce window,
 * meaning the second call should be ignored.
 * A `lastInvocation` of 0 means no previous call (first call — never debounced).
 */
export function isDebounced(lastInvocation: number, now: number): boolean {
    if (lastInvocation === 0) return false;
    return (now - lastInvocation) < DEBOUNCE_MS;
}
