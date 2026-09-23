import { describe, expect, it, vi } from 'vitest';
import { AIProviderError } from './types';
import type { AIConversationRequest, AIConversationResponse, AIProvider } from './types';
import type { TranscriptEntry } from '../types';
import {
    createYoutnoteNotesJsonSchema,
    generateNotesFromTranscript,
    MAX_GENERATED_NOTES,
    parseGeneratedNotes,
    parseMaxNotesInput,
    parseStructuredSegments,
    segmentsToYoutnoteMarkdown,
    YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT,
    YOUTNOTE_AI_SYSTEM_PROMPT,
    YOUTNOTE_SEGMENTS_JSON_SCHEMA,
} from './notes';

const TRANSCRIPT: TranscriptEntry[] = [
    { startMs: 0, text: 'Welcome to the video' },
    { startMs: 10_000, text: 'First topic' },
    { startMs: 3_725_000, text: 'Late topic' },
];

const VALID_RESPONSE = [
    '[00:10](timestamp)',
    'First **note** with markdown',
    'and a second line',
    '',
    '[1:02:05](timestamp)',
    'Late note with a [link](https://example.com)',
].join('\n');

function makeProvider(handler: (request: AIConversationRequest) => AIConversationResponse) {
    const sendConversation = vi.fn((request: AIConversationRequest) => Promise.resolve(handler(request)));
    const provider: AIProvider = {
        id: 'openai',
        sendConversation,
        listModels: vi.fn(() => Promise.resolve([])),
    };
    return { provider, sendConversation };
}

const VALID_JSON = JSON.stringify({
    segments: [
        { timestamp_seconds: 10, markdown: '## First\nFirst **note** with markdown\n- item' },
        { timestamp_seconds: 3725, markdown: 'Late note with a [link](https://example.com)' },
    ],
});

const VALID_JSON_WITH_GENERAL = JSON.stringify({
    general_note: '# Overview\nConcise **summary**',
    segments: [
        { timestamp_seconds: 10, markdown: 'First note' },
        { timestamp_seconds: 3725, markdown: 'Late note' },
    ],
});

const VALID_RESPONSE_WITH_GENERAL = [
    '[general-note](general-note)',
    'Overview of the video',
    '',
    '[00:10](timestamp)',
    'First **note** with markdown',
    'and a second line',
    '',
    '[1:02:05](timestamp)',
    'Late note with a [link](https://example.com)',
].join('\n');

function response(content: string): AIConversationResponse {
    return { content };
}

describe('parseStructuredSegments', () => {
    it('parses valid JSON with rich multiline Obsidian Markdown', () => {
        const segments = parseStructuredSegments(VALID_JSON);
        expect(segments).toEqual([
            { timestamp_seconds: 10, markdown: '## First\nFirst **note** with markdown\n- item' },
            { timestamp_seconds: 3725, markdown: 'Late note with a [link](https://example.com)' },
        ]);
    });

    it('rejects malformed JSON', () => {
        expect(() => parseStructuredSegments('not json'))
            .toThrow(/AI structured response failed validation: Response is not valid JSON/);
        expect(() => parseStructuredSegments('```json\n{"segments":[]}\n```'))
            .toThrow(/not valid JSON/);
    });

    it('rejects non-object JSON and missing or empty segments arrays', () => {
        expect(() => parseStructuredSegments('[1,2]')).toThrow(/not an object/);
        expect(() => parseStructuredSegments('{}')).toThrow(/segments/);
        expect(() => parseStructuredSegments('{"segments":[]}')).toThrow(/segments/);
    });

    it('rejects invalid timestamp_seconds values', () => {
        expect(() => parseStructuredSegments('{"segments":[{"timestamp_seconds":"10","markdown":"x"}]}'))
            .toThrow(/invalid timestamp_seconds/);
        expect(() => parseStructuredSegments('{"segments":[{"timestamp_seconds":-1,"markdown":"x"}]}'))
            .toThrow(/invalid timestamp_seconds/);
        expect(() => parseStructuredSegments('{"segments":[{"timestamp_seconds":null,"markdown":"x"}]}'))
            .toThrow(/invalid timestamp_seconds/);
    });

    it('rejects blank or non-string markdown bodies', () => {
        expect(() => parseStructuredSegments('{"segments":[{"timestamp_seconds":1,"markdown":"   "}]}'))
            .toThrow(/empty markdown/);
        expect(() => parseStructuredSegments('{"segments":[{"timestamp_seconds":1,"markdown":5}]}'))
            .toThrow(/empty markdown/);
    });

    it('rejects out-of-order timestamps and timestamps beyond maxTimestampSec', () => {
        const unordered = JSON.stringify({ segments: [
            { timestamp_seconds: 20, markdown: 'a' },
            { timestamp_seconds: 10, markdown: 'b' },
        ] });
        expect(() => parseStructuredSegments(unordered)).toThrow(/chronological order/);
        expect(() => parseStructuredSegments(VALID_JSON, { maxTimestampSec: 60 }))
            .toThrow(/maximum allowed timestamp/);
    });

    it('rejects more segments than maxNotes', () => {
        expect(() => parseStructuredSegments(VALID_JSON, { maxNotes: 1 }))
            .toThrow(/limit of 1/);
    });

    it('enforces the hard cap of 100 segments when no maxNotes is given', () => {
        const segments = Array.from({ length: MAX_GENERATED_NOTES + 1 }, (_, i) => ({
            timestamp_seconds: i,
            markdown: `Note ${i + 1}`,
        }));
        const payload = JSON.stringify({ segments });
        expect(() => parseStructuredSegments(payload))
            .toThrow(/limit of 100/);
        expect(() => parseStructuredSegments(payload, { maxNotes: 1000 }))
            .toThrow(/limit of 100/);
        expect(() => parseStructuredSegments(payload, { maxNotes: NaN }))
            .toThrow(/limit of 100/);
    });
});

describe('segmentsToYoutnoteMarkdown', () => {
    it('formats the canonical note list exactly', () => {
        const output = segmentsToYoutnoteMarkdown([
            { timestamp_seconds: 10, markdown: '  Note body  ' },
            { timestamp_seconds: 3725, markdown: 'Late body' },
        ]);
        expect(output).toBe('[10](timestamp)\nNote body\n\n[1:02:05](timestamp)\nLate body\n');
    });

    it('places the general-note marker before timestamped markers', () => {
        const output = segmentsToYoutnoteMarkdown(
            [{ timestamp_seconds: 10, markdown: 'Note body' }],
            '  Overview text  ',
        );
        expect(output).toBe('[general-note](general-note)\nOverview text\n\n[10](timestamp)\nNote body\n');
    });
});

describe('createYoutnoteNotesJsonSchema', () => {
    it('returns the segments-only schema unchanged when no general note is requested', () => {
        expect(createYoutnoteNotesJsonSchema(false)).toBe(YOUTNOTE_SEGMENTS_JSON_SCHEMA);
    });

    it('requires general_note alongside the identical segments schema when requested', () => {
        expect(createYoutnoteNotesJsonSchema(true)).toEqual({
            type: 'object',
            additionalProperties: false,
            required: ['general_note', 'segments'],
            properties: {
                general_note: { type: 'string', minLength: 1 },
                segments: (YOUTNOTE_SEGMENTS_JSON_SCHEMA.properties as Record<string, unknown>).segments,
            },
        });
    });

    it('caps segments at the hard maximum of 100 by default', () => {
        const segments = (YOUTNOTE_SEGMENTS_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>).segments;
        expect(segments.minItems).toBe(1);
        expect(segments.maxItems).toBe(MAX_GENERATED_NOTES);
    });

    it('sets segments maxItems to an explicit maxNotes', () => {
        const schema = createYoutnoteNotesJsonSchema(false, 5);
        const segments = (schema.properties as Record<string, Record<string, unknown>>).segments;
        expect(segments.maxItems).toBe(5);
    });

    it('caps maxItems at the hard maximum when maxNotes exceeds it', () => {
        const schema = createYoutnoteNotesJsonSchema(false, 1000);
        const segments = (schema.properties as Record<string, Record<string, unknown>>).segments;
        expect(segments.maxItems).toBe(MAX_GENERATED_NOTES);
    });
});

describe('parseMaxNotesInput', () => {
    it.each<string>(['1', '10', ' 10 ', String(MAX_GENERATED_NOTES)])(
        'accepts valid input %j',
        (value) => {
            expect(parseMaxNotesInput(value)).toBe(Number(value.trim()));
        },
    );

    it.each<string>([
        '',
        '   ',
        '.',
        '10.',
        '10.1',
        '0',
        '-1',
        '101',
        'abc',
        '1e3',
        String(Number.MAX_SAFE_INTEGER + 2),
    ])('rejects invalid input %j', (value) => {
        expect(parseMaxNotesInput(value)).toBeUndefined();
    });
});

describe('parseGeneratedNotes', () => {
    it('parses valid multiline markdown blocks with mixed timestamp formats', () => {
        const notes = parseGeneratedNotes(VALID_RESPONSE);
        expect(notes).toEqual([
            { timestampSec: 10, bodyMarkdown: 'First **note** with markdown\nand a second line' },
            { timestampSec: 3725, bodyMarkdown: 'Late note with a [link](https://example.com)' },
        ]);
    });

    it('accepts raw seconds timestamps', () => {
        const notes = parseGeneratedNotes('[83](timestamp)\nBody');
        expect(notes).toEqual([{ timestampSec: 83, bodyMarkdown: 'Body' }]);
    });

    it('rejects nonblank content before the first delimiter', () => {
        expect(() => parseGeneratedNotes(`Here are your notes:\n${VALID_RESPONSE}`))
            .toThrow(AIProviderError);
    });

    it('rejects responses wrapped in code fences', () => {
        expect(() => parseGeneratedNotes('```\n' + VALID_RESPONSE + '\n```'))
            .toThrow(/code fences/);
    });

    it('rejects malformed delimiter-like lines', () => {
        expect(() => parseGeneratedNotes('[00:10](timestamps)\nBody')).toThrow(/Malformed/);
        expect(() => parseGeneratedNotes('[0a:10](timestamp)\nBody')).toThrow(/Malformed/);
        expect(() => parseGeneratedNotes('**[00:10](timestamp)**\nBody')).toThrow(/Malformed/);
        expect(() => parseGeneratedNotes('[00:10](timestamp)\nBody\n[00:20](caption) caption text'))
            .toThrow(/Malformed/);
    });

    it('rejects empty note bodies', () => {
        expect(() => parseGeneratedNotes('[00:10](timestamp)\n\n[00:20](timestamp)\nBody'))
            .toThrow(/empty body/);
        expect(() => parseGeneratedNotes('[00:10](timestamp)')).toThrow(/empty body/);
    });

    it('rejects out-of-order timestamps', () => {
        const content = '[00:20](timestamp)\nFirst\n[00:10](timestamp)\nSecond';
        expect(() => parseGeneratedNotes(content)).toThrow(/chronological order/);
    });

    it('rejects timestamps beyond maxTimestampSec', () => {
        expect(() => parseGeneratedNotes('[05:00](timestamp)\nBody', { maxTimestampSec: 60 }))
            .toThrow(/exceeds video duration/);
    });

    it('rejects more notes than maxNotes', () => {
        expect(() => parseGeneratedNotes(VALID_RESPONSE, { maxNotes: 1 }))
            .toThrow(/limit of 1/);
    });

    it('rejects responses with no notes', () => {
        expect(() => parseGeneratedNotes('')).toThrow(/no|did not contain/i);
        expect(() => parseGeneratedNotes('just some text')).toThrow(AIProviderError);
    });

    it('accepts a requested general-note block before timestamped notes', () => {
        const notes = parseGeneratedNotes(VALID_RESPONSE_WITH_GENERAL, { includeGeneralNote: true });
        expect(notes).toEqual([
            { timestampSec: -1, bodyMarkdown: 'Overview of the video', isGeneral: true },
            { timestampSec: 10, bodyMarkdown: 'First **note** with markdown\nand a second line' },
            { timestampSec: 3725, bodyMarkdown: 'Late note with a [link](https://example.com)' },
        ]);
    });

    it('rejects a missing general-note block when one was requested', () => {
        expect(() => parseGeneratedNotes(VALID_RESPONSE, { includeGeneralNote: true }))
            .toThrow(/requested general note/);
    });

    it('rejects duplicate, late, empty, and unsolicited general-note blocks', () => {
        const duplicate = VALID_RESPONSE_WITH_GENERAL + '\n\n[general-note](general-note)\nSecond general';
        expect(() => parseGeneratedNotes(duplicate, { includeGeneralNote: true }))
            .toThrow(/more than one general-note/);

        const afterTimestamp = '[00:10](timestamp)\nBody\n\n[general-note](general-note)\nLate general';
        expect(() => parseGeneratedNotes(afterTimestamp, { includeGeneralNote: true }))
            .toThrow(/precede all timestamped/);

        const empty = '[general-note](general-note)\n\n[00:10](timestamp)\nBody';
        expect(() => parseGeneratedNotes(empty, { includeGeneralNote: true }))
            .toThrow(/empty body/);

        expect(() => parseGeneratedNotes(VALID_RESPONSE_WITH_GENERAL))
            .toThrow(/unrequested general-note/);
        expect(() => parseGeneratedNotes(VALID_RESPONSE_WITH_GENERAL, { includeGeneralNote: false }))
            .toThrow(/unrequested general-note/);
    });

    it('counts only timestamped notes against maxNotes', () => {
        expect(parseGeneratedNotes(VALID_RESPONSE_WITH_GENERAL, { includeGeneralNote: true, maxNotes: 2 }))
            .toHaveLength(3);
        expect(() => parseGeneratedNotes(VALID_RESPONSE_WITH_GENERAL, { includeGeneralNote: true, maxNotes: 1 }))
            .toThrow(/limit of 1/);
    });
});

describe('generateNotesFromTranscript', () => {
    it('returns structured notes without a correction turn on a valid first response', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.format).toBe('structured');
        expect(result.corrected).toBe(false);
        expect(result.notes).toEqual([
            { timestampSec: 10, bodyMarkdown: '## First\nFirst **note** with markdown\n- item' },
            { timestampSec: 3725, bodyMarkdown: 'Late note with a [link](https://example.com)' },
        ]);
        expect(result.noteMarkdown).toBe(
            '[10](timestamp)\n## First\nFirst **note** with markdown\n- item\n\n[1:02:05](timestamp)\nLate note with a [link](https://example.com)\n',
        );
        expect(sendConversation).toHaveBeenCalledTimes(1);

        const request = sendConversation.mock.calls[0][0];
        expect(request.systemPrompt).toBe(YOUTNOTE_AI_SYSTEM_PROMPT);
        expect(request.responseSchema).toEqual({
            name: 'youtnote_segments',
            description: 'Timestamped Obsidian Markdown notes generated from a video transcript.',
            schema: YOUTNOTE_SEGMENTS_JSON_SCHEMA,
        });
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0].content).toContain('[10] First topic');
        expect(request.messages[0].content).toContain('[1:02:05] Late topic');
    });

    it('generates a general note first when includeGeneralNote is set', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON_WITH_GENERAL));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT, { includeGeneralNote: true });

        expect(result.format).toBe('structured');
        expect(result.notes[0]).toEqual({
            timestampSec: -1,
            bodyMarkdown: '# Overview\nConcise **summary**',
            isGeneral: true,
        });
        expect(result.notes).toHaveLength(3);
        expect(result.noteMarkdown.startsWith(
            '[general-note](general-note)\n# Overview\nConcise **summary**\n\n[10](timestamp)',
        )).toBe(true);

        const request = sendConversation.mock.calls[0][0];
        expect(request.responseSchema?.schema).toEqual(createYoutnoteNotesJsonSchema(true));
        expect(request.responseSchema?.description)
            .toBe('General and timestamped Obsidian Markdown notes generated from a video transcript.');
        expect(request.messages[0].content).toContain('Also generate a non-empty "general_note"');
    });

    it('treats a missing or blank general_note as a validation failure and recovers via correction', async () => {
        let call = 0;
        const { provider, sendConversation } = makeProvider(() =>
            response(call++ === 0 ? VALID_JSON : VALID_JSON_WITH_GENERAL),
        );
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT, { includeGeneralNote: true });

        expect(result.corrected).toBe(true);
        expect(result.format).toBe('structured');
        expect(result.notes[0].isGeneral).toBe(true);
        expect(sendConversation).toHaveBeenCalledTimes(2);
        expect(sendConversation.mock.calls[1][0].messages[2].content).toContain('general_note');

        call = 0;
        const blank = makeProvider(() =>
            response(call++ === 0
                ? JSON.stringify({ general_note: '  ', segments: [{ timestamp_seconds: 1, markdown: 'x' }] })
                : VALID_JSON_WITH_GENERAL),
        );
        const blankResult = await generateNotesFromTranscript(blank.provider, TRANSCRIPT, { includeGeneralNote: true });
        expect(blankResult.corrected).toBe(true);
        expect(blankResult.notes[0].isGeneral).toBe(true);
    });

    it('keeps the segments-only schema and ignores an unsolicited general_note when not requested', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON_WITH_GENERAL));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        const request = sendConversation.mock.calls[0][0];
        expect(request.responseSchema?.schema).toBe(YOUTNOTE_SEGMENTS_JSON_SCHEMA);
        expect(result.notes).toHaveLength(2);
        expect(result.notes.every(note => note.isGeneral !== true)).toBe(true);
        expect(result.noteMarkdown).not.toContain('[general-note]');
    });

    it('requests and returns a general note through the legacy fallback', async () => {
        const responses = ['not json', '{"segments":[]}', VALID_RESPONSE_WITH_GENERAL];
        let call = 0;
        const { provider, sendConversation } = makeProvider(() => response(responses[call++]));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT, { includeGeneralNote: true });

        expect(result.format).toBe('unstructured');
        expect(result.notes[0]).toEqual({
            timestampSec: -1,
            bodyMarkdown: 'Overview of the video',
            isGeneral: true,
        });
        expect(result.noteMarkdown.startsWith('[general-note](general-note)\n')).toBe(true);
        expect(sendConversation.mock.calls[2][0].messages[0].content)
            .toContain('Generate one general-note block');
        expect(sendConversation.mock.calls[2][0].messages[0].content)
            .not.toContain('non-empty "general_note"');
    });

    it('includes custom instructions and a max note limit in the request', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON));
        await generateNotesFromTranscript(provider, TRANSCRIPT, {
            customInstructions: 'Focus on definitions',
            maxNotes: 5,
        });
        const request = sendConversation.mock.calls[0][0];
        expect(request.messages[0].content).toContain('Focus on definitions');
        expect(request.messages[0].content).toContain('at most 5 timestamped notes');
        expect(request.messages[0].content).toContain('ceiling, not a target');
    });

    it('uses qualitative guidance without anchoring on 100 when maxNotes is blank', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON));
        await generateNotesFromTranscript(provider, TRANSCRIPT);
        const request = sendConversation.mock.calls[0][0];
        expect(request.messages[0].content).toContain('Use only as many notes as the transcript warrants');
        expect(request.messages[0].content).not.toContain('at most 100');
    });

    it('sends one structured correction turn and returns corrected=true on recovery', async () => {
        let call = 0;
        const { provider, sendConversation } = makeProvider(() =>
            response(call++ === 0 ? 'garbage response' : VALID_JSON),
        );
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.format).toBe('structured');
        expect(result.corrected).toBe(true);
        expect(result.notes).toHaveLength(2);
        expect(sendConversation).toHaveBeenCalledTimes(2);

        const secondRequest = sendConversation.mock.calls[1][0];
        expect(secondRequest.systemPrompt).toBe(YOUTNOTE_AI_SYSTEM_PROMPT);
        expect(secondRequest.responseSchema?.name).toBe('youtnote_segments');
        expect(secondRequest.messages).toHaveLength(3);
        expect(secondRequest.messages[0].role).toBe('user');
        expect(secondRequest.messages[1]).toEqual({ role: 'assistant', content: 'garbage response' });
        expect(secondRequest.messages[2].role).toBe('user');
        expect(secondRequest.messages[2].content).toContain('failed JSON validation');
        expect(secondRequest.messages[2].content).toContain('Return only valid JSON');
    });

    it('falls back to the legacy Markdown request after two invalid structured responses', async () => {
        const responses = ['not json', '{"segments":[]}', VALID_RESPONSE];
        let call = 0;
        const { provider, sendConversation } = makeProvider(() => response(responses[call++]));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.format).toBe('unstructured');
        expect(result.corrected).toBe(true);
        expect(result.notes).toHaveLength(2);
        expect(result.noteMarkdown).toBe(VALID_RESPONSE.trim() + '\n');
        expect(sendConversation).toHaveBeenCalledTimes(3);

        const thirdRequest = sendConversation.mock.calls[2][0];
        expect(thirdRequest.systemPrompt).toBe(YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT);
        expect(thirdRequest.responseSchema).toBeUndefined();
        expect(thirdRequest.messages).toHaveLength(1);
        expect(thirdRequest.messages[0].role).toBe('user');
    });

    it('treats invalid-response adapter rejections as validation failures and reaches the legacy fallback', async () => {
        let call = 0;
        const sendConversation = vi.fn((request: AIConversationRequest) => {
            void request;
            call++;
            return call < 3
                ? Promise.reject(new AIProviderError('invalid-response', 'missing structured output'))
                : Promise.resolve(response(VALID_RESPONSE));
        });
        const provider: AIProvider = {
            id: 'anthropic',
            sendConversation,
            listModels: vi.fn(() => Promise.resolve([])),
        };
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.format).toBe('unstructured');
        expect(result.corrected).toBe(true);
        expect(result.notes).toHaveLength(2);
        expect(sendConversation).toHaveBeenCalledTimes(3);

        const secondRequest = sendConversation.mock.calls[1][0];
        expect(secondRequest.messages).toHaveLength(2);
        expect(secondRequest.messages[0].role).toBe('user');
        expect(secondRequest.messages[1].role).toBe('user');
        expect(secondRequest.messages[1].content).toContain('failed JSON validation');
        expect(secondRequest.messages[1].content).toContain('missing structured output');

        const thirdRequest = sendConversation.mock.calls[2][0];
        expect(thirdRequest.systemPrompt).toBe(YOUTNOTE_AI_LEGACY_SYSTEM_PROMPT);
        expect(thirdRequest.responseSchema).toBeUndefined();
    });

    it('throws invalid-response when the legacy fallback is also malformed', async () => {
        const { provider, sendConversation } = makeProvider(() => response('still garbage'));
        await expect(generateNotesFromTranscript(provider, TRANSCRIPT))
            .rejects.toMatchObject({ name: 'AIProviderError', kind: 'invalid-response' });
        expect(sendConversation).toHaveBeenCalledTimes(3);
    });

    it('propagates provider errors without triggering the fallback', async () => {
        const sendConversation = vi.fn(() => Promise.reject(new AIProviderError('provider', 'boom')));
        const provider: AIProvider = {
            id: 'openai',
            sendConversation,
            listModels: vi.fn(() => Promise.resolve([])),
        };
        await expect(generateNotesFromTranscript(provider, TRANSCRIPT))
            .rejects.toMatchObject({ kind: 'provider' });
        expect(sendConversation).toHaveBeenCalledTimes(1);
    });

    it('propagates the abort signal to all attempted calls', async () => {
        const responses = ['bad', 'bad', VALID_RESPONSE];
        let call = 0;
        const { provider, sendConversation } = makeProvider(() => response(responses[call++]));
        const controller = new AbortController();
        await generateNotesFromTranscript(provider, TRANSCRIPT, { signal: controller.signal });

        expect(sendConversation).toHaveBeenCalledTimes(3);
        for (const [request] of sendConversation.mock.calls) {
            expect(request.signal).toBe(controller.signal);
        }
    });

    it.each<{ maxNotes?: number; maxTimestampSec?: number }>([
        { maxNotes: 0 },
        { maxNotes: 1.5 },
        { maxNotes: 101 },
        { maxNotes: Number.MAX_SAFE_INTEGER + 1 },
        { maxTimestampSec: -1 },
        { maxTimestampSec: NaN },
    ])('rejects invalid options %o with invalid-config before calling the provider', async (options) => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON));
        await expect(generateNotesFromTranscript(provider, TRANSCRIPT, options))
            .rejects.toMatchObject({ kind: 'invalid-config' });
        expect(sendConversation).not.toHaveBeenCalled();
    });

    it('rejects an empty transcript with invalid-config before calling the provider', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_JSON));
        await expect(generateNotesFromTranscript(provider, []))
            .rejects.toMatchObject({ kind: 'invalid-config' });
        expect(sendConversation).not.toHaveBeenCalled();
    });
});
