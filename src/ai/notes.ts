import { AIProviderError } from './types';
import type {
    AIConversationRequest,
    AIConversationResponse,
    AIMessage,
    AIProvider,
} from './types';
import type { TranscriptEntry } from '../types';
import { formatSecondsToDisplay, parseTimestampInput } from '../utils';

export interface GeneratedNoteDraft {
    timestampSec: number;
    bodyMarkdown: string;
}

export interface GenerateNotesOptions {
    customInstructions?: string;
    maxNotes?: number;
    maxTimestampSec?: number;
    signal?: AbortSignal;
}

export const YOUTNOTE_AI_SYSTEM_PROMPT = [
    'You generate timestamped study notes for a YouTube video from its transcript.',
    '',
    'Respond ONLY with a list of notes. Each note is a block in this exact format:',
    '',
    '[MM:SS](timestamp)',
    'Markdown note body',
    '',
    'Rules:',
    '- The first line of each block is a timestamp in brackets followed by the literal text "(timestamp)", e.g. [04:12](timestamp). H:MM:SS (e.g. [1:02:05](timestamp)) and raw seconds (e.g. [83](timestamp)) are also accepted.',
    '- Note bodies are valid Obsidian Markdown and may span multiple lines; a block ends at the next timestamp line.',
    '- Output the notes in chronological order. Every timestamp must correspond to a moment in the transcript.',
    '- Do not output YAML frontmatter, video links, [general-note](general-note) markers, [MM:SS](caption) caption markers, code fences, a title, or any explanation. Output the note blocks only.',
].join('\n');

const TIMESTAMP_DELIMITER = /^\[([\d:]+)\]\(timestamp\)\s*$/;
const DELIMITER_LIKE_OPEN = /^\s*\[[\d:]+\]\(/;
const DELIMITER_LIKE_CLOSE = /\]\(timestamp\)/;
const CODE_FENCE = /^\s*(`{3,}|~{3,})/;

interface ParseSuccess {
    ok: true;
    notes: GeneratedNoteDraft[];
}

interface ParseFailure {
    ok: false;
    error: string;
}

type ParseResult = ParseSuccess | ParseFailure;

function fail(error: string): ParseFailure {
    return { ok: false, error };
}

function tryParseGeneratedNotes(
    content: string,
    maxNotes: number | undefined,
    maxTimestampSec: number | undefined,
): ParseResult {
    const lines = content.split('\n');
    const notes: GeneratedNoteDraft[] = [];
    let pendingBody: string[] | null = null;
    let pendingSec = 0;
    let lastSec = -1;

    const flush = (): string | null => {
        if (pendingBody === null) {
            return null;
        }
        const body = pendingBody.join('\n').trim();
        if (!body) {
            return `Note at ${formatSecondsToDisplay(pendingSec, 0)} has an empty body.`;
        }
        notes.push({ timestampSec: pendingSec, bodyMarkdown: body });
        return null;
    };

    for (const line of lines) {
        const delimiter = TIMESTAMP_DELIMITER.exec(line);
        if (delimiter) {
            const flushError = flush();
            if (flushError !== null) {
                return fail(flushError);
            }
            const parsed = parseTimestampInput(delimiter[1], maxTimestampSec ?? 0);
            if (parsed.error) {
                return fail(`Invalid timestamp "${delimiter[1]}": ${parsed.error}.`);
            }
            if (parsed.seconds < lastSec) {
                return fail(`Timestamp "${delimiter[1]}" is out of chronological order.`);
            }
            lastSec = parsed.seconds;
            pendingSec = parsed.seconds;
            pendingBody = [];
            continue;
        }
        if (CODE_FENCE.test(line)) {
            return fail('Response must not contain code fences.');
        }
        if (DELIMITER_LIKE_OPEN.test(line) || DELIMITER_LIKE_CLOSE.test(line)) {
            return fail(`Malformed timestamp delimiter line: "${line.trim()}".`);
        }
        if (pendingBody === null) {
            if (line.trim() !== '') {
                return fail('Unexpected content before the first timestamped note.');
            }
            continue;
        }
        pendingBody.push(line);
    }

    const flushError = flush();
    if (flushError !== null) {
        return fail(flushError);
    }
    if (notes.length === 0) {
        return fail('Response did not contain any timestamped notes.');
    }
    if (maxNotes !== undefined && notes.length > maxNotes) {
        return fail(`Response contained ${notes.length} notes, exceeding the limit of ${maxNotes}.`);
    }
    return { ok: true, notes };
}

export function parseGeneratedNotes(
    content: string,
    options?: Pick<GenerateNotesOptions, 'maxNotes' | 'maxTimestampSec'>,
): GeneratedNoteDraft[] {
    const result = tryParseGeneratedNotes(content, options?.maxNotes, options?.maxTimestampSec);
    if (!result.ok) {
        throw new AIProviderError('invalid-response', `AI response failed note validation: ${result.error}`);
    }
    return result.notes;
}

function buildTranscriptRequest(transcript: TranscriptEntry[], options: GenerateNotesOptions): string {
    const lines: string[] = [
        'Generate timestamped Obsidian notes from the following transcript.',
    ];
    const customInstructions = options.customInstructions?.trim();
    if (customInstructions) {
        lines.push('', `Additional instructions: ${customInstructions}`);
    }
    if (typeof options.maxNotes === 'number' && Number.isInteger(options.maxNotes) && options.maxNotes > 0) {
        lines.push('', `Return at most ${options.maxNotes} notes.`);
    }
    lines.push('', 'Transcript:');
    for (const entry of transcript) {
        const sec = Math.max(0, Math.floor(entry.startMs / 1000));
        lines.push(`[${formatSecondsToDisplay(sec, 0)}] ${entry.text}`);
    }
    return lines.join('\n');
}

export async function generateNotesFromTranscript(
    provider: AIProvider,
    transcript: TranscriptEntry[],
    options: GenerateNotesOptions = {},
): Promise<{ notes: GeneratedNoteDraft[]; response: AIConversationResponse; corrected: boolean }> {
    if (transcript.length === 0) {
        throw new AIProviderError('invalid-config', 'Cannot generate notes from an empty transcript.');
    }
    if (options.maxNotes !== undefined && (!Number.isInteger(options.maxNotes) || options.maxNotes <= 0)) {
        throw new AIProviderError('invalid-config', 'Maximum notes must be a positive integer.');
    }
    if (options.maxTimestampSec !== undefined && (!Number.isFinite(options.maxTimestampSec) || options.maxTimestampSec < 0)) {
        throw new AIProviderError('invalid-config', 'Maximum timestamp must be a non-negative number.');
    }

    const systemPrompt = YOUTNOTE_AI_SYSTEM_PROMPT;
    const messages: AIMessage[] = [{ role: 'user', content: buildTranscriptRequest(transcript, options) }];
    const buildRequest = (): AIConversationRequest => {
        const request: AIConversationRequest = { systemPrompt, messages };
        if (options.signal) {
            request.signal = options.signal;
        }
        return request;
    };

    const first = await provider.sendConversation(buildRequest());
    const firstResult = tryParseGeneratedNotes(first.content, options.maxNotes, options.maxTimestampSec);
    if (firstResult.ok) {
        return { notes: firstResult.notes, response: first, corrected: false };
    }

    messages.push({ role: 'assistant', content: first.content });
    messages.push({
        role: 'user',
        content: `Your previous response failed validation: ${firstResult.error} Return the corrected list of notes only, in the exact required format, with no explanation.`,
    });
    const second = await provider.sendConversation(buildRequest());
    const secondResult = tryParseGeneratedNotes(second.content, options.maxNotes, options.maxTimestampSec);
    if (!secondResult.ok) {
        throw new AIProviderError(
            'invalid-response',
            `AI returned invalid notes after a correction attempt: ${secondResult.error}`,
        );
    }
    return { notes: secondResult.notes, response: second, corrected: true };
}
