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
    isGeneral?: boolean;
}

export interface GenerateNotesOptions {
    customInstructions?: string;
    maxNotes?: number;
    maxTimestampSec?: number;
    includeGeneralNote?: boolean;
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

const SEGMENTS_SCHEMA: Record<string, unknown> = {
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
};

export const YOUTNOTE_SEGMENTS_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['segments'],
    properties: {
        segments: SEGMENTS_SCHEMA,
    },
};

export function createYoutnoteNotesJsonSchema(includeGeneralNote: boolean): Record<string, unknown> {
    if (!includeGeneralNote) {
        return YOUTNOTE_SEGMENTS_JSON_SCHEMA;
    }
    return {
        type: 'object',
        additionalProperties: false,
        required: ['general_note', 'segments'],
        properties: {
            general_note: { type: 'string', minLength: 1 },
            segments: SEGMENTS_SCHEMA,
        },
    };
}

export const YOUTNOTE_AI_SYSTEM_PROMPT = [
    'You generate study notes for a YouTube video from its transcript.',
    '',
    'Respond ONLY with a JSON object matching the provided schema. It contains a "segments" array where each segment has a numeric "timestamp_seconds" and an Obsidian Markdown "markdown" string. When the schema requires "general_note", include it as an Obsidian Markdown string.',
    '',
    'Rules:',
    '- timestamp_seconds is the transcript moment in seconds the note refers to. Output segments in chronological order and ground every timestamp in the transcript.',
    '- Segment markdown is a valid Obsidian Markdown note body and may span multiple lines; it may contain headers, bold, italic, links, callouts, and lists.',
    '- A requested general_note can be a description of the video or a concise summary. It also supports Obsidian Markdown.',
    '- Do not output YAML frontmatter, video links, marker lines, code fences, a title outside the note content, or any explanation. Output the JSON object only.',
].join('\n');

export const YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT = [
    'You generate study notes for a YouTube video from its transcript.',
    '',
    'Respond ONLY with note blocks. Each timestamped note uses this exact format:',
    '',
    '[MM:SS](timestamp)',
    'Markdown note body',
    '',
    'When a general note is requested, place this block before all timestamped notes:',
    '',
    '[general-note](general-note)',
    'Markdown general note body',
    '',
    'Rules:',
    '- The first line of each timestamped block is a timestamp in brackets followed by the literal text "(timestamp)", e.g. [04:12](timestamp). H:MM:SS (e.g. [1:02:05](timestamp)) and raw seconds (e.g. [83](timestamp)) are also accepted.',
    '- Note bodies are valid Obsidian Markdown and may span multiple lines; a block ends at the next marker line.',
    '- Output timestamped notes in chronological order. Every timestamp must correspond to a moment in the transcript.',
    '- A requested general note can be a description of the video or a concise summary and supports Obsidian Markdown.',
    '- Do not output a general-note block unless it is requested.',
    '- Do not output YAML frontmatter, video links, caption markers, code fences, a title outside the note content, or any explanation. Output note blocks only.',
].join('\n');

const TIMESTAMP_DELIMITER = /^\[([\d:]+)\]\(timestamp\)\s*$/;
const GENERAL_NOTE_DELIMITER = /^\[general-note\]\(general-note\)\s*$/;
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
    includeGeneralNote: boolean,
): ParseResult {
    const lines = content.split('\n');
    const notes: GeneratedNoteDraft[] = [];
    let generalDraft: GeneratedNoteDraft | null = null;
    let generalSeen = false;
    let timestampedSeen = false;
    let pendingBody: string[] | null = null;
    let pendingSec = 0;
    let pendingIsGeneral = false;
    let lastSec = -1;

    const flush = (): string | null => {
        if (pendingBody === null) {
            return null;
        }
        const body = pendingBody.join('\n').trim();
        if (!body) {
            if (pendingIsGeneral) {
                return 'The general note has an empty body.';
            }
            return `Note at ${formatSecondsToDisplay(pendingSec, 0)} has an empty body.`;
        }
        if (pendingIsGeneral) {
            generalDraft = { timestampSec: -1, bodyMarkdown: body, isGeneral: true };
        } else {
            notes.push({ timestampSec: pendingSec, bodyMarkdown: body });
        }
        return null;
    };

    for (const line of lines) {
        if (GENERAL_NOTE_DELIMITER.test(line)) {
            const flushError = flush();
            if (flushError !== null) {
                return fail(flushError);
            }
            if (!includeGeneralNote) {
                return fail('Response contained an unrequested general-note block.');
            }
            if (generalSeen) {
                return fail('Response contained more than one general-note block.');
            }
            if (timestampedSeen) {
                return fail('The general-note block must precede all timestamped notes.');
            }
            generalSeen = true;
            pendingIsGeneral = true;
            pendingBody = [];
            continue;
        }
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
            timestampedSeen = true;
            pendingIsGeneral = false;
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
    if (includeGeneralNote && generalDraft === null) {
        return fail('Response did not contain the requested general note.');
    }
    if (notes.length === 0) {
        return fail('Response did not contain any timestamped notes.');
    }
    if (maxNotes !== undefined && notes.length > maxNotes) {
        return fail(`Response contained ${notes.length} notes, exceeding the limit of ${maxNotes}.`);
    }
    return { ok: true, notes: generalDraft ? [generalDraft, ...notes] : notes };
}

export function parseGeneratedNotes(
    content: string,
    options?: Pick<GenerateNotesOptions, 'maxNotes' | 'maxTimestampSec' | 'includeGeneralNote'>,
): GeneratedNoteDraft[] {
    const result = tryParseGeneratedNotes(
        content,
        options?.maxNotes,
        options?.maxTimestampSec,
        options?.includeGeneralNote === true,
    );
    if (!result.ok) {
        throw new AIProviderError('invalid-response', `AI response failed note validation: ${result.error}`);
    }
    return result.notes;
}

interface StructuredParseSuccess {
    ok: true;
    segments: GeneratedNoteSegment[];
    generalNoteMarkdown: string | undefined;
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
    includeGeneralNote: boolean,
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
    let generalNoteMarkdown: string | undefined;
    if (includeGeneralNote) {
        if (typeof parsed.general_note !== 'string' || !parsed.general_note.trim()) {
            return structuredFail('Response JSON does not contain a non-empty "general_note" string.');
        }
        generalNoteMarkdown = parsed.general_note.trim();
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
    return { ok: true, segments, generalNoteMarkdown };
}

export function parseStructuredSegments(
    content: string,
    options?: Pick<GenerateNotesOptions, 'maxNotes' | 'maxTimestampSec'>,
): GeneratedNoteSegment[] {
    const result = tryParseStructuredSegments(content, options?.maxNotes, options?.maxTimestampSec, false);
    if (!result.ok) {
        throw new AIProviderError('invalid-response', `AI structured response failed validation: ${result.error}`);
    }
    return result.segments;
}

export function segmentsToYoutnoteMarkdown(
    segments: GeneratedNoteSegment[],
    generalNoteMarkdown?: string,
): string {
    const blocks = segments.map(segment =>
        `[${formatSecondsToDisplay(segment.timestamp_seconds, 0)}](timestamp)\n${segment.markdown.trim()}`
    );
    if (generalNoteMarkdown) {
        blocks.unshift(`[general-note](general-note)\n${generalNoteMarkdown.trim()}`);
    }
    return blocks.join('\n\n') + '\n';
}

function buildTranscriptRequest(
    transcript: TranscriptEntry[],
    options: GenerateNotesOptions,
    intro: string = 'Generate timestamped Obsidian notes from the following transcript.',
    includeStructuredGeneralInstruction: boolean = true,
): string {
    const lines: string[] = [intro];
    const customInstructions = options.customInstructions?.trim();
    if (customInstructions) {
        lines.push('', `Additional instructions: ${customInstructions}`);
    }
    if (includeStructuredGeneralInstruction && options.includeGeneralNote === true) {
        lines.push('', 'Also generate a non-empty "general_note". It can be a description of the video or a concise summary, and it may use Obsidian Markdown.');
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

    const includeGeneralNote = options.includeGeneralNote === true;
    const responseSchema: AIResponseSchema = {
        name: 'youtnote_segments',
        description: includeGeneralNote
            ? 'General and timestamped Obsidian Markdown notes generated from a video transcript.'
            : 'Timestamped Obsidian Markdown notes generated from a video transcript.',
        schema: createYoutnoteNotesJsonSchema(includeGeneralNote),
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
        generalNoteMarkdown: string | undefined,
        response: AIConversationResponse,
        corrected: boolean,
    ): GeneratedNotesResult => ({
        notes: [
            ...(generalNoteMarkdown ? [{
                timestampSec: -1,
                bodyMarkdown: generalNoteMarkdown,
                isGeneral: true,
            }] : []),
            ...segments.map(segment => ({
                timestampSec: segment.timestamp_seconds,
                bodyMarkdown: segment.markdown,
            })),
        ],
        noteMarkdown: segmentsToYoutnoteMarkdown(segments, generalNoteMarkdown),
        response,
        corrected,
        format: 'structured',
    });

    const attemptStructured = async (): Promise<
        | { ok: true; response: AIConversationResponse; segments: GeneratedNoteSegment[]; generalNoteMarkdown: string | undefined }
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
        const parsed = tryParseStructuredSegments(
            response.content,
            options.maxNotes,
            options.maxTimestampSec,
            includeGeneralNote,
        );
        if (!parsed.ok) {
            return { ok: false, response, error: parsed.error };
        }
        return { ok: true, response, segments: parsed.segments, generalNoteMarkdown: parsed.generalNoteMarkdown };
    };

    const first = await attemptStructured();
    if (first.ok) {
        return toStructuredResult(first.segments, first.generalNoteMarkdown, first.response, false);
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
        return toStructuredResult(second.segments, second.generalNoteMarkdown, second.response, true);
    }

    const legacyRequest: AIConversationRequest = {
        systemPrompt: YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT,
        messages: [{
            role: 'user',
            content: buildTranscriptRequest(
                transcript,
                options,
                includeGeneralNote
                    ? 'Generate one general-note block followed by timestamped Youtnote note blocks from the following transcript. The general note can be a description of the video or a concise summary and may use Obsidian Markdown.'
                    : 'Generate timestamped Youtnote note blocks ([MM:SS](timestamp) followed by the Markdown note body) from the following transcript.',
                false,
            ),
        }],
    };
    if (options.signal) {
        legacyRequest.signal = options.signal;
    }
    const third = await provider.sendConversation(legacyRequest);
    const thirdResult = tryParseGeneratedNotes(
        third.content,
        options.maxNotes,
        options.maxTimestampSec,
        includeGeneralNote,
    );
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
