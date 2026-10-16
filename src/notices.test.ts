import { describe, expect, it, vi } from 'vitest';
import { showYoutnoteNotice } from './notices';

interface NoticeRecord {
    message: string;
    timeout: number | undefined;
    classes: string[];
}

const noticeRecords: NoticeRecord[] = [];

vi.mock('obsidian', () => {
    class FakeNotice {
        messageEl = {
            addClass: (cls: string): void => {
                noticeRecords[noticeRecords.length - 1]?.classes.push(cls);
            },
        };
        constructor(message?: unknown, timeout?: number) {
            noticeRecords.push({ message: String(message), timeout, classes: [] });
        }
    }
    return { Notice: FakeNotice };
});

describe('showYoutnoteNotice', () => {
    it('defaults to a normal notice with a 3000ms duration and no classes', () => {
        noticeRecords.length = 0;
        showYoutnoteNotice('hello');
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0]).toEqual({ message: 'hello', timeout: 3000, classes: [] });
    });

    it('defaults warning and error notices to persistent and applies the theme class', () => {
        noticeRecords.length = 0;
        showYoutnoteNotice('warn', { severity: 'warning' });
        showYoutnoteNotice('err', { severity: 'error' });
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(noticeRecords[1].timeout).toBe(0);
        expect(noticeRecords[1].classes).toEqual(['youtnote-plugin__notice-error']);
    });

    it.each([0, 5000])('honors an explicit duration of %s', (duration) => {
        noticeRecords.length = 0;
        showYoutnoteNotice('x', { severity: 'warning', duration });
        expect(noticeRecords[0].timeout).toBe(duration);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
    });

    it('applies no theme class for normal severity even when persistent', () => {
        noticeRecords.length = 0;
        showYoutnoteNotice('x', { severity: 'normal', duration: 0 });
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual([]);
    });
});
