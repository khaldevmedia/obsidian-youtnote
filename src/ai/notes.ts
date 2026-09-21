import { AIProviderError } from './types';
import type {
    AIConversationRequest,
    AIConversationResponse,
    AIMessage,
    AIProvider,
    AIResponseSchema,
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

export interface GeneratedNoteSegment {
    timestamp_seconds: number;
    markdown: string;
}

export type GeneratedNotesFormat = 'structured' | 'unstructured';

export interface GeneratedNotesResult {
    notes: GeneratedNoteDraft[];
    noteMarkdown: string;
    response: AIConversationResponse;
    corrected: boolean;
    format: GeneratedNotesFormat;
}

export const YOUTNOTE_SEGMENTS_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['segments'],
    properties: {
        segments: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['timestamp_seconds', 'markdown'],
                properties: {
                    timestamp_seconds: { type: 'number', minimum: 0 },
                    markdown: { type: 'string', minLength: 1 },
                },
            },
        },
    },
};

export const YOUTNOTE_AI_SYSTEM_PROMPT = [
    'You generate timestamped study notes for a YouTube video from its transcript.',
    '',
    'Respond ONLY with a JSON object matching the provided schema: a "segments" array where each segment has a numeric "timestamp_seconds" and an Obsidian Markdown "markdown" string.',
    '',
    'Rules:',
    '- timestamp_seconds is the transcript moment in seconds the note refers to. Output segments in chronological order and ground every timestamp in the transcript.',
    '- markdown is a valid Obsidian Markdown note body and may span multiple lines; it may contain headers, bold, italic, links, callouts, and lists.',
    '- Do not output YAML frontmatter, video links, code fences, a title, or any explanation. Output the JSON object only.',
].join('\n');

export const YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT = [
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

interface StructuredParseSuccess {
    ok: true;
    segments: GeneratedNoteSegment[];
}

interface StructuredParseFailure {
    ok: false;
    error: string;
}

type StructuredParseResult = StructuredParseSuccess | StructuredParseFailure;

function structuredFail(error: string): StructuredParseFailure {
    return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseStructuredSegments(
    content: string,
    maxNotes: number | undefined,
    maxTimestampSec: number | undefined,
): StructuredParseResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        return structuredFail(`Response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) {
        return structuredFail('Response JSON is not an object.');
    }
    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        return structuredFail('Response JSON does not contain a non-empty "segments" array.');
    }

    const segments: GeneratedNoteSegment[] = [];
    let lastSec = -1;
    for (let i = 0; i < parsed.segments.length; i++) {
        const item: unknown = parsed.segments[i];
        const label = `Segment ${i + 1}`;
        if (!isRecord(item)) {
            return structuredFail(`${label} is not an object.`);
        }
        if (typeof item.timestamp_seconds !== 'number' || !Number.isFinite(item.timestamp_seconds) || item.timestamp_seconds < 0) {
            return structuredFail(`${label} has an invalid timestamp_seconds value.`);
        }
        if (maxTimestampSec !== undefined && item.timestamp_seconds > maxTimestampSec) {
            return structuredFail(`${label} timestamp_seconds exceeds the maximum allowed timestamp.`);
        }
        if (item.timestamp_seconds < lastSec) {
            return structuredFail(`${label} is out of chronological order.`);
        }
        if (typeof item.markdown !== 'string' || !item.markdown.trim()) {
            return structuredFail(`${label} has an empty markdown body.`);
        }
        lastSec = item.timestamp_seconds;
        segments.push({ timestamp_seconds: item.timestamp_seconds, markdown: item.markdown.trim() });
    }

    if (maxNotes !== undefined && segments.length > maxNotes) {
        return structuredFail(`Response contained ${segments.length} segments, exceeding the limit of ${maxNotes}.`);
    }
    return { ok: true, segments };
}

export function parseStructuredSegments(
    content: string,
    options?: Pick<GenerateNotesOptions, 'maxNotes' | 'maxTimestampSec'>,
): GeneratedNoteSegment[] {
    const result = tryParseStructuredSegments(content, options?.maxNotes, options?.maxTimestampSec);
    if (!result.ok) {
        throw new AIProviderError('invalid-response', `AI structured response failed validation: ${result.error}`);
    }
    return result.segments;
}

export function segmentsToYoutnoteMarkdown(segments: GeneratedNoteSegment[]): string {
    return segments.map(segment =>
        `[${formatSecondsToDisplay(segment.timestamp_seconds, 0)}](timestamp)\n${segment.markdown.trim()}`
    ).join('\n\n') + '\n';
}

function buildTranscriptRequest(
    transcript: TranscriptEntry[],
    options: GenerateNotesOptions,
    intro: string = 'Generate timestamped Obsidian notes from the following transcript.',
): string {
    const lines: string[] = [intro];
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
): Promise<GeneratedNotesResult> {
    if (transcript.length === 0) {
        throw new AIProviderError('invalid-config', 'Cannot generate notes from an empty transcript.');
    }
    if (options.maxNotes !== undefined && (!Number.isInteger(options.maxNotes) || options.maxNotes <= 0)) {
        throw new AIProviderError('invalid-config', 'Maximum notes must be a positive integer.');
    }
    if (options.maxTimestampSec !== undefined && (!Number.isFinite(options.maxTimestampSec) || options.maxTimestampSec < 0)) {
        throw new AIProviderError('invalid-config', 'Maximum timestamp must be a non-negative number.');
    }

    const responseSchema: AIResponseSchema = {
        name: 'youtnote_segments',
        description: 'Timestamped Obsidian Markdown notes generated from a video transcript.',
        schema: YOUTNOTE_SEGMENTS_JSON_SCHEMA,
    };
    const messages: AIMessage[] = [{ role: 'user', content: buildTranscriptRequest(transcript, options) }];
    const buildStructuredRequest = (): AIConversationRequest => {
        const request: AIConversationRequest = {
            systemPrompt: YOUTNOTE_AI_SYSTEM_PROMPT,
            messages,
            responseSchema,
        };
        if (options.signal) {
            request.signal = options.signal;
        }
        return request;
    };
    const toStructuredResult = (
        segments: GeneratedNoteSegment[],
        response: AIConversationResponse,
        corrected: boolean,
    ): GeneratedNotesResult => ({
        notes: segments.map(segment => ({
            timestampSec: segment.timestamp_seconds,
            bodyMarkdown: segment.markdown,
        })),
        noteMarkdown: segmentsToYoutnoteMarkdown(segments),
        response,
        corrected,
        format: 'structured',
    });

    const attemptStructured = async (): Promise<
        | { ok: true; response: AIConversationResponse; segments: GeneratedNoteSegment[] }
        | { ok: false; response: AIConversationResponse | null; error: string }
    > => {
        let response: AIConversationResponse;
        try {
            response = await provider.sendConversation(buildStructuredRequest());
        } catch (error) {
            if (error instanceof AIProviderError && error.kind === 'invalid-response') {
                return { ok: false, response: null, error: error.message };
            }
            throw error;
        }
        const parsed = tryParseStructuredSegments(response.content, options.maxNotes, options.maxTimestampSec);
        if (!parsed.ok) {
            return { ok: false, response, error: parsed.error };
        }
        return { ok: true, response, segments: parsed.segments };
    };

    const first = await attemptStructured();
    if (first.ok) {
        return toStructuredResult(first.segments, first.response, false);
    }

    if (first.response) {
        messages.push({ role: 'assistant', content: first.response.content });
    }
    messages.push({
        role: 'user',
        content: `Your previous response failed JSON validation: ${first.error} Return only valid JSON matching the required schema, with no code fence or explanation.`,
    });
    const second = await attemptStructured();
    if (second.ok) {
        return toStructuredResult(second.segments, second.response, true);
    }

    const legacyRequest: AIConversationRequest = {
        systemPrompt: YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT,
        messages: [{
            role: 'user',
            content: buildTranscriptRequest(
                transcript,
                options,
                'Generate timestamped Youtnote note blocks ([MM:SS](timestamp) followed by the Markdown note body) from the following transcript.',
            ),
        }],
    };
    if (options.signal) {
        legacyRequest.signal = options.signal;
    }
    const third = await provider.sendConversation(legacyRequest);
    const thirdResult = tryParseGeneratedNotes(third.content, options.maxNotes, options.maxTimestampSec);
    if (!thirdResult.ok) {
        throw new AIProviderError(
            'invalid-response',
            `AI structured correction and unstructured fallback both failed: ${thirdResult.error}`,
        );
    }
    return {
        notes: thirdResult.notes,
        noteMarkdown: third.content.trim() + '\n',
        response: third,
        corrected: true,
        format: 'unstructured',
    };
}
