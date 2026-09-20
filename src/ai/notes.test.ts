import { describe, expect, it, vi } from 'vitest';
import { AIProviderError } from './types';
import type { AIConversationRequest, AIConversationResponse, AIProvider } from './types';
import type { TranscriptEntry } from '../types';
import {
    generateNotesFromTranscript,
    parseGeneratedNotes,
    YOUTNOTE_AI_SYSTEM_PROMPT,
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

function response(content: string): AIConversationResponse {
    return { content };
}

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
});

describe('generateNotesFromTranscript', () => {
    it('returns parsed notes without a correction turn on a valid first response', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_RESPONSE));
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.corrected).toBe(false);
        expect(result.notes).toHaveLength(2);
        expect(sendConversation).toHaveBeenCalledTimes(1);

        const request = sendConversation.mock.calls[0][0];
        expect(request.systemPrompt).toBe(YOUTNOTE_AI_SYSTEM_PROMPT);
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0].content).toContain('[10] First topic');
        expect(request.messages[0].content).toContain('[1:02:05] Late topic');
    });

    it('includes custom instructions and a max note limit in the request', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_RESPONSE));
        await generateNotesFromTranscript(provider, TRANSCRIPT, {
            customInstructions: 'Focus on definitions',
            maxNotes: 5,
        });
        const request = sendConversation.mock.calls[0][0];
        expect(request.messages[0].content).toContain('Focus on definitions');
        expect(request.messages[0].content).toContain('at most 5 notes');
    });

    it('sends one correction turn and returns corrected=true on recovery', async () => {
        let call = 0;
        const { provider, sendConversation } = makeProvider(() =>
            response(call++ === 0 ? 'garbage response' : VALID_RESPONSE),
        );
        const result = await generateNotesFromTranscript(provider, TRANSCRIPT);

        expect(result.corrected).toBe(true);
        expect(result.notes).toHaveLength(2);
        expect(sendConversation).toHaveBeenCalledTimes(2);

        const secondRequest = sendConversation.mock.calls[1][0];
        expect(secondRequest.systemPrompt).toBe(YOUTNOTE_AI_SYSTEM_PROMPT);
        expect(secondRequest.messages).toHaveLength(3);
        expect(secondRequest.messages[0].role).toBe('user');
        expect(secondRequest.messages[1]).toEqual({ role: 'assistant', content: 'garbage response' });
        expect(secondRequest.messages[2].role).toBe('user');
        expect(secondRequest.messages[2].content).toContain('failed validation');
        expect(secondRequest.messages[2].content).toContain('corrected list');
    });

    it('throws invalid-response when the correction is also malformed', async () => {
        const { provider, sendConversation } = makeProvider(() => response('still garbage'));
        await expect(generateNotesFromTranscript(provider, TRANSCRIPT))
            .rejects.toMatchObject({ name: 'AIProviderError', kind: 'invalid-response' });
        expect(sendConversation).toHaveBeenCalledTimes(2);
    });

    it('propagates the abort signal to both calls', async () => {
        let call = 0;
        const { provider, sendConversation } = makeProvider(() =>
            response(call++ === 0 ? 'bad' : VALID_RESPONSE),
        );
        const controller = new AbortController();
        await generateNotesFromTranscript(provider, TRANSCRIPT, { signal: controller.signal });

        expect(sendConversation).toHaveBeenCalledTimes(2);
        expect(sendConversation.mock.calls[0][0].signal).toBe(controller.signal);
        expect(sendConversation.mock.calls[1][0].signal).toBe(controller.signal);
    });

    it.each<{ maxNotes?: number; maxTimestampSec?: number }>([
        { maxNotes: 0 },
        { maxNotes: 1.5 },
        { maxTimestampSec: -1 },
        { maxTimestampSec: NaN },
    ])('rejects invalid options %o with invalid-config before calling the provider', async (options) => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_RESPONSE));
        await expect(generateNotesFromTranscript(provider, TRANSCRIPT, options))
            .rejects.toMatchObject({ kind: 'invalid-config' });
        expect(sendConversation).not.toHaveBeenCalled();
    });

    it('rejects an empty transcript with invalid-config before calling the provider', async () => {
        const { provider, sendConversation } = makeProvider(() => response(VALID_RESPONSE));
        await expect(generateNotesFromTranscript(provider, []))
            .rejects.toMatchObject({ kind: 'invalid-config' });
        expect(sendConversation).not.toHaveBeenCalled();
    });
});
