import { describe, expect, it } from 'vitest';
import type { TFile } from 'obsidian';
import { KeyedSerialQueue } from './keyedSerialQueue';

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const fileA = unsafeCast<TFile>({ path: 'a.md' });
const fileB = unsafeCast<TFile>({ path: 'b.md' });

describe('KeyedSerialQueue', () => {
    it('runs same-key tasks strictly in order even when the first is pending', async () => {
        const queue = new KeyedSerialQueue<TFile>();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const first = queue.run(fileA, async () => {
            await gate;
            events.push('first-end');
            return 'first';
        });
        const second = queue.run(fileA, async () => {
            events.push('second-end');
            return 'second';
        });
        events.push('second-queued');
        release();
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        expect(events).toEqual(['second-queued', 'first-end', 'second-end']);
    });

    it('runs tasks for different keys concurrently', async () => {
        const queue = new KeyedSerialQueue<TFile>();
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const slow = queue.run(fileA, async () => {
            await gate;
            events.push('slow-end');
            return 'slow';
        });
        const fast = queue.run(fileB, async () => {
            events.push('fast-end');
            return 'fast';
        });
        await expect(fast).resolves.toBe('fast');
        expect(events).toEqual(['fast-end']);
        release();
        await expect(slow).resolves.toBe('slow');
        expect(events).toEqual(['fast-end', 'slow-end']);
    });

    it('does not let a rejected task block the next same-key task', async () => {
        const queue = new KeyedSerialQueue<TFile>();
        const events: string[] = [];
        const first = queue.run(fileA, async () => {
            throw new Error('boom');
        });
        const second = queue.run(fileA, async () => {
            events.push('second-end');
            return 'ok';
        });
        await expect(first).rejects.toThrow('boom');
        await expect(second).resolves.toBe('ok');
        expect(events).toEqual(['second-end']);
    });

    it('preserves the returned value and thrown error of a queued task', async () => {
        const queue = new KeyedSerialQueue<TFile>();
        const value = await queue.run(fileA, async () => 42);
        expect(value).toBe(42);
        const error = new Error('preserved');
        await expect(queue.run(fileA, async () => { throw error; })).rejects.toBe(error);
    });
});
