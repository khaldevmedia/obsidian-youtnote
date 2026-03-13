/**
 * Formats seconds to display string without using Date objects.
 * Supports videos of any length (including 200+ hours).
 * Uses format based on video duration to indicate total video length:
 * - H:MM:SS format indicates video is 1+ hour long
 * - M:SS format indicates video is 1+ minute long but less than 1 hour  
 * - SS format indicates video is less than 1 minute long
 * 
 * @param seconds - Time in seconds to format
 * @param durationSec - Total video duration in seconds (used to determine format)
 * @returns Formatted timestamp string
 */
export function formatSecondsToDisplay(seconds: number, durationSec: number = 0): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const pad = (num: number) => num.toString().padStart(2, '0');

    // Format based on video duration to indicate total video length
    // h:mm:ss format indicates video is 1+ hour long
    if (durationSec >= 3600) {
        return `${h}:${pad(m)}:${pad(s)}`;
    } 
    // mm:ss format indicates video is 1+ minute long but less than 1 hour
    else if (durationSec >= 60) {
        return `${m}:${pad(s)}`;
    } 
    // When duration is unknown (0), use timestamp structure to determine format
    else if (durationSec === 0) {
        if (h > 0) {
            return `${h}:${pad(m)}:${pad(s)}`;
        } else if (m > 0) {
            return `${m}:${pad(s)}`;
        } else {
            return `${s}`;
        }
    }
    // ss format indicates video is less than 1 minute long
    else {
        return `${s}`;
    }
}


const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'www.youtube.com',
    'www.youtu.be',
    'www.youtube-nocookie.com'
]);

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

function isValidYouTubeId(value: string): boolean {
    return YOUTUBE_ID_REGEX.test(value);
}

function parseUrl(value: string): URL | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
        return new URL(trimmed);
    } catch (err) {
        console.error("Error parsing URL:", e);
        try {
            return new URL(`https://${trimmed}`);
        } catch (err) {
            console.error("Error parsing URL:", e);
            return null;
        }
    }
}


export function extractYouTubeId(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;

    if (isValidYouTubeId(trimmed)) {
        return trimmed;
    }

    const parsed = parseUrl(trimmed);
    if (!parsed) return null;

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) {
        return null;
    }

    let candidate: string | null = null;

    if (host.includes('youtu.be')) {
        candidate = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (parsed.pathname === '/watch') {
        candidate = parsed.searchParams.get('v');
    } else if (parsed.pathname.startsWith('/shorts/')) {
        candidate = parsed.pathname.split('/')[2] || null;
    } else if (parsed.pathname.startsWith('/live/')) {
        candidate = parsed.pathname.split('/')[2] || null;
    } else if (parsed.pathname.startsWith('/embed/')) {
        candidate = parsed.pathname.split('/')[2] || null;
    }

    if (!candidate) {
        return null;
    }

    return isValidYouTubeId(candidate) ? candidate : null;
}

/**
 * Normalizes YouTube URLs to a consistent format: https://www.youtube.com/watch?v=VIDEO_ID
 * Strips playlist parameters and converts shortened/shorts/live URLs to standard format.
 * 
 * Supported input formats:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://www.youtube.com/watch?v=VIDEO_ID&list=PLAYLIST_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/shorts/VIDEO_ID
 * - https://www.youtube.com/live/VIDEO_ID
 * - https://www.youtube.com/live/VIDEO_ID?si=SHARE_ID
 * 
 * @param url - YouTube URL to normalize
 * @returns Normalized URL or null if invalid
 */
export function normalizeYouTubeUrl(url: string): string | null {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
        return null;
    }
    return `https://www.youtube.com/watch?v=${videoId}`;
}

export function hasYoutnoteFrontmatter(content: string): boolean {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') {
        return false;
    }

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line === '---') {
            return false;
        }

        if (/^youtnote\s*:\s*true\s*$/i.test(line)) {
            return true;
        }
    }

    return false;
}

export function isSafeExternalUrl(rawUrl: string): boolean {
    const parsed = parseUrl(rawUrl);
    if (!parsed) return false;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Parses timestamp input string to seconds with validation.
 * Supports extended durations (200+ hours) and flexible input formats.
 * 
 * Input formats:
 * - Standard time: "h:mm:ss" or "mm:ss" (e.g., "1:30", "12:50:20", "200:00:00")
 * - Seconds only: Integer inputs (e.g., "90") treated as raw seconds
 * 
 * Ambiguity rules:
 * - "1:30" = 1 minute 30 seconds (90 seconds)
 * - "1:30:00" = 1 hour 30 minutes (5400 seconds)
 * - "90" = 90 seconds
 * 
 * @param input - Timestamp string to parse
 * @param maxDuration - Maximum allowed duration in seconds (video length)
 * @returns Object with parsed seconds and optional error message
 */
export function parseTimestampInput(input: string, maxDuration: number): { seconds: number; error?: string } {
    // Trim whitespace
    const trimmed = input.trim();
    
    if (!trimmed) {
        return { seconds: 0, error: 'Empty input' };
    }

    // Validate that input only contains digits, colons, and optional decimal points
    // Valid formats: s, m:s, h:m:s (where each segment can be a number with optional decimal)
    if (!/^[\d.:]+$/.test(trimmed)) {
        return { seconds: 0, error: 'Invalid format: only numbers and colons allowed' };
    }

    // Check if input contains colons (time format) or is just a number
    if (!trimmed.includes(':')) {
        // Treat as raw seconds
        const seconds = parseFloat(trimmed);
        
        if (isNaN(seconds)) {
            return { seconds: 0, error: 'Invalid number format' };
        }
        
        if (seconds < 0) {
            return { seconds: 0, error: 'Time cannot be negative' };
        }
        
        if (maxDuration > 0 && seconds > maxDuration) {
            return { seconds: maxDuration, error: `Time exceeds video duration (max: ${formatSecondsToDisplay(maxDuration)})` };
        }
        
        return { seconds: Math.floor(seconds) };
    }

    // Parse colon-separated time format
    const segments = trimmed.split(':');
    
    // Validate that we don't have empty segments or consecutive colons
    if (segments.some(seg => seg.trim() === '')) {
        return { seconds: 0, error: 'Invalid format: empty segment' };
    }
    
    // Validate segment count (max 3: hours:minutes:seconds)
    if (segments.length > 3) {
        return { seconds: 0, error: 'Invalid format: too many segments' };
    }

    // Parse each segment as a number
    const values = segments.map(seg => {
        const num = parseFloat(seg);
        return isNaN(num) ? null : num;
    });

    // Check for invalid segments
    if (values.some(v => v === null)) {
        return { seconds: 0, error: 'Invalid format: non-numeric segment' };
    }

    // Check for negative values
    if (values.some(v => v! < 0)) {
        return { seconds: 0, error: 'Time segments cannot be negative' };
    }

    // Calculate total seconds using backwards iteration
    // Segments are interpreted as: [seconds] or [minutes, seconds] or [hours, minutes, seconds]
    let totalSeconds = 0;
    for (let i = 0; i < values.length; i++) {
        const reverseIndex = values.length - 1 - i;
        const multiplier = Math.pow(60, i);
        totalSeconds += values[reverseIndex]! * multiplier;
    }

    totalSeconds = Math.floor(totalSeconds);

    // Validate against bounds
    if (totalSeconds < 0) {
        return { seconds: 0, error: 'Time cannot be negative' };
    }

    if (maxDuration > 0 && totalSeconds > maxDuration) {
        return { seconds: maxDuration, error: `Time exceeds video duration (max: ${formatSecondsToDisplay(maxDuration)})` };
    }

    return { seconds: totalSeconds };
}

/**
 * Calculates the total word count from an array of note body markdown strings.
 * Words are counted by splitting on whitespace.
 * 
 * @param noteBodies - Array of markdown strings from note bodies
 * @returns Total word count
 */
export function calculateTotalWords(noteBodies: string[]): number {
    return noteBodies.reduce((total, body) => {
        const trimmed = body.trim();
        if (!trimmed) return total;
        // Split on whitespace and filter out empty strings
        const words = trimmed.split(/\s+/).filter(word => word.length > 0);
        return total + words.length;
    }, 0);
}

/**
 * Calculates the total character count from an array of note body markdown strings.
 * Counts all characters including spaces.
 * 
 * @param noteBodies - Array of markdown strings from note bodies
 * @returns Total character count
 */
export function calculateTotalCharacters(noteBodies: string[]): number {
    return noteBodies.reduce((total, body) => total + body.length, 0);
}
