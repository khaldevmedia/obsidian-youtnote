import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
    App: class App {},
    Notice: class Notice {},
    PluginSettingTab: class PluginSettingTab {},
    SecretComponent: class SecretComponent {},
    Setting: class Setting {},
}));

vi.mock('./main', () => ({ default: class YoutnotePlugin {} }));

import { DEFAULT_SETTINGS, mergePluginSettings } from './settings';

describe('mergePluginSettings', () => {
    it('returns defaults for missing or non-object input', () => {
        expect(mergePluginSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(mergePluginSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(mergePluginSettings('junk')).toEqual(DEFAULT_SETTINGS);
        expect(mergePluginSettings(42)).toEqual(DEFAULT_SETTINGS);
    });

    it('retains top-level defaults and applies top-level overrides', () => {
        const merged = mergePluginSettings({ autoplayOnNoteSelect: true, newLineTrigger: 'enter' });
        expect(merged.autoplayOnNoteSelect).toBe(true);
        expect(merged.newLineTrigger).toBe('enter');
        expect(merged.showNoteStats).toBe(DEFAULT_SETTINGS.showNoteStats);
        expect(merged.uriSchemeEnabled).toBe(DEFAULT_SETTINGS.uriSchemeEnabled);
    });

    it('deeply merges a partial ai block', () => {
        const merged = mergePluginSettings({
            ai: {
                enabled: true,
                provider: 'openai',
                secretNames: { openai: 'my-secret' },
                models: { openai: 'gpt-4o' },
                availableModels: { openai: ['gpt-4o', 'gpt-4o-mini'] },
                hostedTimeoutSeconds: 60,
            },
        });
        expect(merged.ai.enabled).toBe(true);
        expect(merged.ai.provider).toBe('openai');
        expect(merged.ai.secretNames).toEqual({ openai: 'my-secret', anthropic: '', google: '', custom: '' });
        expect(merged.ai.models).toEqual({ openai: 'gpt-4o', anthropic: '', google: '', custom: '' });
        expect(merged.ai.availableModels).toEqual({ openai: ['gpt-4o', 'gpt-4o-mini'], anthropic: [], google: [], custom: [] });
        expect(merged.ai.customBaseUrl).toBe('');
        expect(merged.ai.hostedTimeoutSeconds).toBe(60);
        expect(merged.ai.customTimeoutSeconds).toBe(300);
    });

    it('sanitizes invalid provider ids to none', () => {
        expect(mergePluginSettings({ ai: { provider: 'bogus' } }).ai.provider).toBe('none');
        expect(mergePluginSettings({ ai: { provider: 42 } }).ai.provider).toBe('none');
        for (const id of ['none', 'openai', 'anthropic', 'google', 'custom'] as const) {
            expect(mergePluginSettings({ ai: { provider: id } }).ai.provider).toBe(id);
        }
    });

    it('rejects non-positive or non-finite timeouts', () => {
        const merged = mergePluginSettings({
            ai: { hostedTimeoutSeconds: 0, customTimeoutSeconds: 'fast' },
        });
        expect(merged.ai.hostedTimeoutSeconds).toBe(120);
        expect(merged.ai.customTimeoutSeconds).toBe(300);
        expect(mergePluginSettings({ ai: { hostedTimeoutSeconds: -3, customTimeoutSeconds: NaN } }).ai.hostedTimeoutSeconds).toBe(120);
        expect(mergePluginSettings({ ai: { hostedTimeoutSeconds: Infinity } }).ai.hostedTimeoutSeconds).toBe(120);
        expect(mergePluginSettings({ ai: { customTimeoutSeconds: 45 } }).ai.customTimeoutSeconds).toBe(45);
    });

    it('sanitizes model lists to arrays of strings', () => {
        const merged = mergePluginSettings({
            ai: {
                availableModels: {
                    openai: 'not-an-array',
                    anthropic: ['a', 1, 'b', null],
                    google: ['g1'],
                },
                models: { openai: 123 },
                secretNames: { anthropic: {} },
            },
        });
        expect(merged.ai.availableModels).toEqual({ openai: [], anthropic: ['a', 'b'], google: ['g1'], custom: [] });
        expect(merged.ai.models.openai).toBe('');
        expect(merged.ai.secretNames.anthropic).toBe('');
    });

    it('preserves unknown top-level properties for a later save', () => {
        const merged = mergePluginSettings({
            futureTextSetting: 'future-value',
            someFutureFlag: { nested: true },
        }) as unknown as Record<string, unknown>;
        expect(merged.futureTextSetting).toBe('future-value');
        expect(merged.someFutureFlag).toEqual({ nested: true });
    });

    it('does not share references with the defaults', () => {
        const merged = mergePluginSettings({});
        expect(merged.ai).not.toBe(DEFAULT_SETTINGS.ai);
        expect(merged.ai.availableModels).not.toBe(DEFAULT_SETTINGS.ai.availableModels);
        merged.ai.availableModels.openai.push('x');
        expect(DEFAULT_SETTINGS.ai.availableModels.openai).toEqual([]);
    });
});
