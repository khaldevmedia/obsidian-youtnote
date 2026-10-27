import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_URLS, MAX_VIDEO_URL_TEXT_LENGTH, parseVideoUrlList } from './videoUrlList';

const ID1 = 'aircAruvnKk';
const ID2 = 'SZorAJ4I7xg';
const ID3 = 'ytNewVid901';
const ID4 = 'ytNewVid902';

function parsedIds(text: string): string[] {
    const result = parseVideoUrlList(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return [];
    return result.videos.map(v => v.youtubeId);
}

describe('parseVideoUrlList', () => {
    it('parses a numbered list of mobile watch links', () => {
        const result = parseVideoUrlList([
            `1. https://m.youtube.com/watch?v=${ID1}`,
            `2. https://m.youtube.com/watch?v=${ID2}`,
            `3. https://m.youtube.com/watch?v=${ID3}`,
            `4. https://m.youtube.com/watch?v=${ID4}`,
        ].join('\n'));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.videos.map(v => v.youtubeId)).toEqual([ID1, ID2, ID3, ID4]);
        expect(result.videos.map(v => v.line)).toEqual([1, 2, 3, 4]);
        expect(result.videos.map(v => v.key)).toEqual(['provided-1', 'provided-2', 'provided-3', 'provided-4']);
        expect(result.videos[0].url).toBe(`https://www.youtube.com/watch?v=${ID1}`);
    });

    it('parses unnumbered mixed URL forms into canonical watch links', () => {
        expect(parsedIds([
            `https://www.youtube.com/watch?v=${ID1}`,
            `https://youtu.be/${ID2}`,
            `https://www.youtube.com/shorts/${ID3}`,
            `https://www.youtube.com/live/${ID4}?si=abc`,
            `https://www.youtube.com/embed/${ID1}`,
        ].join('\n'))).toEqual([ID1, ID2, ID3, ID4, ID1]);
    });

    it('handles CRLF, CR, blank lines and spacing', () => {
        const text = `\r\n1. https://youtu.be/${ID1}\r\r\n\n   \n2.   https://youtu.be/${ID2}   \n`;
        const result = parseVideoUrlList(text);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.videos.map(v => v.youtubeId)).toEqual([ID1, ID2]);
        expect(result.videos.map(v => v.line)).toEqual([2, 6]);
    });

    it('strips playlist, index and tracking parameters including mix lists', () => {
        const result = parseVideoUrlList(`https://www.youtube.com/watch?v=${ID1}&list=RDMMabc&index=3&pp=ygUJdGVzdA%3D%3D&t=42`);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.videos[0].youtubeId).toBe(ID1);
        expect(result.videos[0].url).toBe(`https://www.youtube.com/watch?v=${ID1}`);
    });

    it('keeps repeated ids as separate ordered rows', () => {
        const result = parseVideoUrlList([
            `https://youtu.be/${ID1}`,
            `https://youtu.be/${ID2}`,
            `https://youtu.be/${ID1}`,
        ].join('\n'));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.videos.map(v => v.youtubeId)).toEqual([ID1, ID2, ID1]);
        expect(result.videos.map(v => v.key)).toEqual(['provided-1', 'provided-2', 'provided-3']);
    });

    it('allows schemeless YouTube links', () => {
        expect(parsedIds(`www.youtube.com/watch?v=${ID1}\nyoutu.be/${ID2}`))
            .toEqual([ID1, ID2]);
    });

    it('rejects the whole parse when any nonblank line is invalid', () => {
        const result = parseVideoUrlList([
            `https://youtu.be/${ID1}`,
            'definitely not a link',
            `https://youtu.be/${ID2}`,
        ].join('\n'));
        expect(result).toMatchObject({ ok: false, code: 'invalid', lines: [2] });
    });

    it('collects every invalid physical line number', () => {
        const cases = [
            `https://www.youtube.com/playlist?list=PLVbEymL-83SyVXXqT7fYX5sEvELvyGjL7`,
            `https://youtube.com.evil.example/watch?v=${ID1}`,
            `https://user@www.youtube.com/watch?v=${ID1}`,
            `ftp://www.youtube.com/watch?v=${ID1}`,
            'javascript:alert(1)',
            ID1,
            `https://youtu.be/${ID1} https://youtu.be/${ID2}`,
            `check this https://youtu.be/${ID1}`,
            `https://youtu.be/${ID1} great video`,
            '3.',
            `1 https://youtu.be/${ID1}`,
        ];
        const result = parseVideoUrlList(cases.join('\n'));
        expect(result).toMatchObject({ ok: false, code: 'invalid', lines: cases.map((_, i) => i + 1) });
    });

    it.each([
        `1) https://youtu.be/${ID1}`,
        `1.https://youtu.be/${ID1}`,
        `2 https://youtu.be/${ID1}`,
    ])('rejects numbering prefix %j', (line) => {
        expect(parseVideoUrlList(line)).toMatchObject({ ok: false, code: 'invalid', lines: [1] });
    });

    it.each(['\n', '\r\n', '\r'])('reports raw invalid entries with UTF16 ranges for %j newlines', (nl) => {
        const raw3 = `   4. https://example.com/watch?v=${ID1}  `;
        const raw6 = '2 notalink';
        const text = [
            `1. https://youtu.be/${ID1}`,
            '',
            raw3,
            `https://youtu.be/${ID2}`,
            '   ',
            raw6,
            `3. youtu.be/${ID1}`,
        ].join(nl);
        const result = parseVideoUrlList(text);
        expect(result).toMatchObject({ ok: false, code: 'invalid', lines: [3, 6] });
        if (result.ok || result.code !== 'invalid') return;
        expect(result.invalidEntries).toHaveLength(2);
        expect(result.invalidEntries.map(e => e.text)).toEqual([raw3, raw6]);
        expect(result.invalidEntries.map(e => e.line)).toEqual([3, 6]);
        for (const entry of result.invalidEntries) {
            expect(text.slice(entry.start, entry.end)).toBe(entry.text);
        }
    });

    it('tracks UTF16 offsets across unicode content before invalid lines', () => {
        const bad1 = 'bad \u{1F600}';
        const bad2 = 'also bad';
        const text = `${bad1}\nhttps://youtu.be/${ID1}\n${bad2}`;
        const result = parseVideoUrlList(text);
        expect(result).toMatchObject({ ok: false, code: 'invalid', lines: [1, 3] });
        if (result.ok || result.code !== 'invalid') return;
        expect(text.slice(result.invalidEntries[0].start, result.invalidEntries[0].end)).toBe(bad1);
        expect(text.slice(result.invalidEntries[1].start, result.invalidEntries[1].end)).toBe(bad2);
    });

    it('gives repeated identical invalid lines distinct ranges', () => {
        const raw = 'not a link';
        const text = `${raw}\n${raw}`;
        const result = parseVideoUrlList(text);
        if (result.ok || result.code !== 'invalid') throw new Error('expected invalid result');
        expect(result.invalidEntries).toHaveLength(2);
        expect(result.invalidEntries[0].start).not.toBe(result.invalidEntries[1].start);
        expect(text.slice(result.invalidEntries[0].start, result.invalidEntries[0].end)).toBe(raw);
        expect(text.slice(result.invalidEntries[1].start, result.invalidEntries[1].end)).toBe(raw);
    });

    it('reports empty for blank input', () => {
        expect(parseVideoUrlList('')).toEqual({ ok: false, code: 'empty', lines: [] });
        expect(parseVideoUrlList('   \n\n  \r\n\t ')).toEqual({ ok: false, code: 'empty', lines: [] });
    });

    it('allows exactly the row cap and rejects one above it', () => {
        const line = `https://youtu.be/${ID1}`;
        const atCap = parseVideoUrlList(Array.from({ length: MAX_VIDEO_URLS }, () => line).join('\n'));
        expect(atCap.ok).toBe(true);
        const overCap = parseVideoUrlList(Array.from({ length: MAX_VIDEO_URLS + 1 }, () => line).join('\n'));
        expect(overCap).toEqual({ ok: false, code: 'limit', lines: [] });
    });

    it('bounds the raw text length before parsing', () => {
        const text = `https://youtu.be/${ID1}\n`.repeat(MAX_VIDEO_URL_TEXT_LENGTH / 24 + 2);
        expect(parseVideoUrlList(text)).toEqual({ ok: false, code: 'text-limit', lines: [] });
    });
});
