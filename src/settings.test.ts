import { describe, expect, it, vi } from 'vitest';

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
    return {
        App: class App {},
        Notice: FakeNotice,
        PluginSettingTab: class PluginSettingTab {},
        SecretComponent: class SecretComponent {},
        Setting: class Setting {},
    };
});

vi.mock('./main', () => ({ default: class YoutnotePlugin {} }));

import { DEFAULT_SETTINGS, mergePluginSettings, refreshAIModelList, YoutnoteSettingTab } from './settings';
import { GITHUB_DOCS_BRANCH, URI_SCHEME_GUIDE_URL } from './constants';
import { AIProviderError } from './ai/types';
import type { AISettings } from './types';

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

describe('autoplayOnCaptionSelect', () => {
    it('defaults to false for fresh installs', () => {
        expect(DEFAULT_SETTINGS.autoplayOnCaptionSelect).toBe(false);
        expect(mergePluginSettings({}).autoplayOnCaptionSelect).toBe(false);
        expect(mergePluginSettings(undefined).autoplayOnCaptionSelect).toBe(false);
    });

    it('seeds the caption flag from a saved note preference', () => {
        expect(mergePluginSettings({ autoplayOnNoteSelect: true }).autoplayOnCaptionSelect).toBe(true);
        expect(mergePluginSettings({ autoplayOnNoteSelect: false }).autoplayOnCaptionSelect).toBe(false);
    });

    it('keeps saved opposite flag values independent', () => {
        const merged = mergePluginSettings({ autoplayOnNoteSelect: false, autoplayOnCaptionSelect: true });
        expect(merged.autoplayOnCaptionSelect).toBe(true);
        expect(merged.autoplayOnNoteSelect).toBe(false);
    });

    it('falls back to the saved note preference when the caption value is invalid', () => {
        expect(mergePluginSettings({ autoplayOnNoteSelect: true, autoplayOnCaptionSelect: 'yes' }).autoplayOnCaptionSelect).toBe(true);
        expect(mergePluginSettings({ autoplayOnNoteSelect: false, autoplayOnCaptionSelect: 1 }).autoplayOnCaptionSelect).toBe(false);
        expect(mergePluginSettings({ autoplayOnCaptionSelect: true }).autoplayOnCaptionSelect).toBe(true);
    });

    it('keeps an explicit saved caption false through a JSON round-trip when the note flag is true', () => {
        const saved = JSON.stringify({ autoplayOnNoteSelect: true, autoplayOnCaptionSelect: false });
        const merged = mergePluginSettings(JSON.parse(saved));
        expect(merged.autoplayOnCaptionSelect).toBe(false);
        expect(merged.autoplayOnNoteSelect).toBe(true);
    });
});

describe('caption autoplay settings controls', () => {
    const stubFragment = () => {
        vi.stubGlobal('createFragment', (callback: (frag: {
            appendText(text: string): void;
            createEl(tag: string): unknown;
        }) => void) => {
            callback({ appendText: vi.fn(), createEl: () => ({}) });
            return {};
        });
    };

    it('exposes distinct toggle keys for note and caption autoplay', () => {
        stubFragment();
        try {
            const tab = new YoutnoteSettingTab({} as never, { settings: DEFAULT_SETTINGS } as never);
            const controls = tab.getSettingDefinitions()
                .flatMap(group => group.items)
                .flatMap(item => ('control' in item && item.control.type === 'toggle'
                    ? [{ key: item.control.key, name: item.name }]
                    : []));
            const noteToggle = controls.find(c => c.key === 'autoplayOnNoteSelect');
            const captionToggle = controls.find(c => c.key === 'autoplayOnCaptionSelect');
            expect(noteToggle).toBeDefined();
            expect(captionToggle).toBeDefined();
            expect(captionToggle!.name).not.toBe(noteToggle!.name);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('setControlValue updates only the caption flag and persists once', async () => {
        const saveDataState = vi.fn(() => Promise.resolve());
        const refreshAllViews = vi.fn();
        const plugin = {
            settings: mergePluginSettings({ autoplayOnNoteSelect: true }),
            saveDataState,
            refreshAllViews,
        };
        const tab = new YoutnoteSettingTab({} as never, plugin as never);

        await tab.setControlValue('autoplayOnCaptionSelect', false);
        expect(plugin.settings.autoplayOnCaptionSelect).toBe(false);
        expect(plugin.settings.autoplayOnNoteSelect).toBe(true);
        expect(saveDataState).toHaveBeenCalledTimes(1);
        expect(refreshAllViews).toHaveBeenCalledTimes(1);

        await tab.setControlValue('autoplayOnNoteSelect', false);
        expect(plugin.settings.autoplayOnNoteSelect).toBe(false);
        expect(plugin.settings.autoplayOnCaptionSelect).toBe(false);
        expect(saveDataState).toHaveBeenCalledTimes(2);
        expect(refreshAllViews).toHaveBeenCalledTimes(2);
    });
});

describe('refreshAIModelList', () => {
    const makeAI = (mutate?: (ai: AISettings) => void): AISettings => {
        const ai: AISettings = {
            enabled: true,
            provider: 'openai',
            secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
            models: { openai: '', anthropic: '', google: '', custom: '' },
            availableModels: { openai: [], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        };
        mutate?.(ai);
        return ai;
    };

    it('applies a completed fetch and reports an available selection', async () => {
        const ai = makeAI(aiSettings => { aiSettings.models.openai = 'b-model'; });
        const result = await refreshAIModelList(ai, 'openai', () => Promise.resolve(['a-model', 'b-model']));
        expect(result).toEqual({
            status: 'updated',
            models: ['a-model', 'b-model'],
            selectedModelUnavailable: false,
        });
        expect(ai.availableModels.openai).toEqual(['a-model', 'b-model']);
        expect(ai.models.openai).toBe('b-model');
    });

    it('preserves a nonblank selection missing from the refreshed list', async () => {
        const ai = makeAI(aiSettings => { aiSettings.models.openai = 'old-model'; });
        const result = await refreshAIModelList(ai, 'openai', () => Promise.resolve(['a-model', 'b-model']));
        expect(result).toMatchObject({ status: 'updated', selectedModelUnavailable: true });
        expect(ai.models.openai).toBe('old-model');
        expect(ai.availableModels.openai).toEqual(['a-model', 'b-model']);
    });

    it('initializes the first model when the selection is empty at start and completion', async () => {
        const ai = makeAI();
        const result = await refreshAIModelList(ai, 'openai', () => Promise.resolve(['a-model', 'b-model']));
        expect(result).toMatchObject({ status: 'updated', selectedModelUnavailable: false });
        expect(ai.models.openai).toBe('a-model');
    });

    it('keeps a selection the user changed while the fetch was pending', async () => {
        const ai = makeAI();
        const result = await refreshAIModelList(ai, 'openai', () => {
            ai.models.openai = 'user-picked';
            return Promise.resolve(['a-model', 'b-model']);
        });
        expect(result).toMatchObject({ status: 'updated', selectedModelUnavailable: true });
        expect(ai.models.openai).toBe('user-picked');
    });

    it('leaves the selection empty when the user clears it while the fetch is pending', async () => {
        const ai = makeAI(aiSettings => { aiSettings.models.openai = 'chosen'; });
        const result = await refreshAIModelList(ai, 'openai', () => {
            ai.models.openai = '';
            return Promise.resolve(['a-model', 'b-model']);
        });
        expect(result).toMatchObject({ status: 'updated', selectedModelUnavailable: false });
        expect(ai.models.openai).toBe('');
        expect(ai.availableModels.openai).toEqual(['a-model', 'b-model']);
    });

    it('propagates a failed fetch without mutating cache or selection', async () => {
        const ai = makeAI(aiSettings => {
            aiSettings.models.openai = 'chosen';
            aiSettings.availableModels.openai = ['cached'];
        });
        await expect(refreshAIModelList(ai, 'openai', () => Promise.reject(new Error('boom'))))
            .rejects.toThrow('boom');
        expect(ai.availableModels.openai).toEqual(['cached']);
        expect(ai.models.openai).toBe('chosen');
    });

    it('rejects an empty model list without mutating', async () => {
        const ai = makeAI(aiSettings => { aiSettings.models.openai = 'chosen'; });
        await expect(refreshAIModelList(ai, 'openai', () => Promise.resolve([])))
            .rejects.toMatchObject({ kind: 'invalid-response' });
        expect(ai.models.openai).toBe('chosen');
        expect(ai.availableModels.openai).toEqual([]);
    });

    it.each<['provider' | 'secret']>([['provider'], ['secret']])(
        'returns stale and discards the fetch when the %s changes mid-request',
        async (changed) => {
            const ai = makeAI(aiSettings => {
                aiSettings.models.openai = 'chosen';
                aiSettings.availableModels.openai = ['cached'];
            });
            const result = await refreshAIModelList(ai, 'openai', () => {
                if (changed === 'provider') {
                    ai.provider = 'anthropic';
                } else {
                    ai.secretNames.openai = 'other-secret';
                }
                return Promise.resolve(['a-model']);
            });
            expect(result).toEqual({ status: 'stale' });
            expect(ai.availableModels.openai).toEqual(['cached']);
            expect(ai.models.openai).toBe('chosen');
        },
    );

    it('returns stale when the custom base URL changes during a custom refresh', async () => {
        const ai = makeAI(aiSettings => {
            aiSettings.provider = 'custom';
            aiSettings.models.custom = 'chosen';
            aiSettings.availableModels.custom = ['cached'];
            aiSettings.customBaseUrl = 'http://localhost:11434/v1';
        });
        const result = await refreshAIModelList(ai, 'custom', () => {
            ai.customBaseUrl = 'http://localhost:1234/v1';
            return Promise.resolve(['a-model']);
        });
        expect(result).toEqual({ status: 'stale' });
        expect(ai.availableModels.custom).toEqual(['cached']);
        expect(ai.models.custom).toBe('chosen');
    });

    it('still applies a hosted refresh when the custom base URL changes mid-request', async () => {
        const ai = makeAI(aiSettings => {
            aiSettings.models.openai = 'chosen';
        });
        const result = await refreshAIModelList(ai, 'openai', () => {
            ai.customBaseUrl = 'http://localhost:1234/v1';
            return Promise.resolve(['a-model']);
        });
        expect(result).toMatchObject({ status: 'updated', models: ['a-model'], selectedModelUnavailable: true });
        expect(ai.availableModels.openai).toEqual(['a-model']);
        expect(ai.models.openai).toBe('chosen');
    });
});

describe('Model list refresh button', () => {
    const makeAI = (mutate?: (ai: AISettings) => void): AISettings => {
        const ai: AISettings = {
            enabled: true,
            provider: 'openai',
            secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
            models: { openai: '', anthropic: '', google: '', custom: '' },
            availableModels: { openai: [], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        };
        mutate?.(ai);
        return ai;
    };

    const buildRefreshClick = (ai: AISettings, listAIModels: () => Promise<string[]>) => {
        const saveDataState = vi.fn(() => Promise.resolve());
        const plugin = {
            settings: { ai },
            saveDataState,
            refreshAllViews: vi.fn(),
            listAIModels,
        };
        const tab = new YoutnoteSettingTab(
            {} as never,
            plugin as never,
        );
        (tab as unknown as { display: () => void }).display = vi.fn();
        const group = (tab as unknown as {
            buildAIGroup(): { items: { name: string; render?: (setting: unknown) => void }[] };
        }).buildAIGroup();
        const item = group.items.find(entry => entry.name === 'Model list');
        expect(item).toBeDefined();
        const captured: { click?: () => Promise<void> } = {};
        const button = {
            setButtonText: vi.fn(function (this: unknown) { return this; }),
            setDisabled: vi.fn(function (this: unknown) { return this; }),
            onClick: vi.fn((callback: () => Promise<void>) => {
                captured.click = callback;
                return button;
            }),
        };
        const setting = {
            addButton: vi.fn((callback: (component: unknown) => void) => {
                callback(button);
                return setting;
            }),
        };
        item!.render!(setting);
        expect(captured.click).toBeDefined();
        return { captured, saveDataState, listAIModels, button };
    };

    it('persists a refreshed model list and reports the count', async () => {
        const ai: AISettings = {
            enabled: true,
            provider: 'openai',
            secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
            models: { openai: '', anthropic: '', google: '', custom: '' },
            availableModels: { openai: [], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        };
        const listAIModels = vi.fn(() => Promise.resolve(['m1', 'm2']));
        const { captured, saveDataState } = buildRefreshClick(ai, listAIModels);
        noticeRecords.length = 0;
        await captured.click!();
        expect(listAIModels).toHaveBeenCalledTimes(1);
        expect(saveDataState).toHaveBeenCalledTimes(1);
        expect(ai.availableModels.openai).toEqual(['m1', 'm2']);
        expect(ai.models.openai).toBe('m1');
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(3000);
        expect(noticeRecords[0].classes).toEqual([]);
        expect(noticeRecords[0].message).toContain('Loaded 2 models.');
    });

    it('ignores a stale refresh result without persisting', async () => {
        const ai: AISettings = {
            enabled: true,
            provider: 'openai',
            secretNames: { openai: 's1', anthropic: '', google: '', custom: '' },
            models: { openai: 'chosen', anthropic: '', google: '', custom: '' },
            availableModels: { openai: ['cached'], anthropic: [], google: [], custom: [] },
            customBaseUrl: '',
            hostedTimeoutSeconds: 120,
            customTimeoutSeconds: 300,
        };
        const listAIModels = vi.fn(() => {
            ai.provider = 'anthropic';
            return Promise.resolve(['m1']);
        });
        const { captured, saveDataState, button } = buildRefreshClick(ai, listAIModels);
        noticeRecords.length = 0;
        await captured.click!();
        expect(saveDataState).not.toHaveBeenCalled();
        expect(ai.availableModels.openai).toEqual(['cached']);
        expect(ai.models.openai).toBe('chosen');
        expect(noticeRecords).toHaveLength(0);
        expect((button.setDisabled.mock.calls as unknown as boolean[][]).at(-1)?.[0]).toBe(false);
        expect((button.setButtonText.mock.calls as unknown as string[][]).at(-1)?.[0]).toBe('Refresh models');
    });

    it('warns persistently when the selected model is missing from the refreshed list', async () => {
        const ai = makeAI(aiSettings => { aiSettings.models.openai = 'old-model'; });
        const { captured, saveDataState } = buildRefreshClick(ai, vi.fn(() => Promise.resolve(['m1', 'm2'])));
        noticeRecords.length = 0;
        await captured.click!();
        expect(saveDataState).toHaveBeenCalledTimes(1);
        expect(ai.models.openai).toBe('old-model');
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(noticeRecords[0].message).toContain('Loaded 2 models.');
        expect(noticeRecords[0].message).toContain('not in the fetched list');
    });

    it('warns persistently with detail and advice on a provider overload', async () => {
        const ai = makeAI(aiSettings => {
            aiSettings.models.openai = 'chosen';
            aiSettings.availableModels.openai = ['cached'];
        });
        const { captured, saveDataState } = buildRefreshClick(ai, vi.fn(() =>
            Promise.reject(new AIProviderError('provider', 'Service overloaded', 503, 'UNAVAILABLE'))));
        noticeRecords.length = 0;
        await captured.click!();
        expect(saveDataState).not.toHaveBeenCalled();
        expect(ai.availableModels.openai).toEqual(['cached']);
        expect(ai.models.openai).toBe('chosen');
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-warning']);
        expect(noticeRecords[0].message).toContain('Service overloaded');
        expect(noticeRecords[0].message).toContain('temporarily unavailable');
    });

    it('shows an error with account guidance on an insufficient-quota rate limit', async () => {
        const ai = makeAI();
        const { captured, saveDataState } = buildRefreshClick(ai, vi.fn(() =>
            Promise.reject(new AIProviderError('provider', 'Quota exceeded', 429, 'insufficient_quota'))));
        noticeRecords.length = 0;
        await captured.click!();
        expect(saveDataState).not.toHaveBeenCalled();
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(noticeRecords[0].message).toContain('Quota exceeded');
        expect(noticeRecords[0].message).toContain('billing, or quota');
    });

    it('shows a persistent error on an authentication failure', async () => {
        const ai = makeAI();
        const { captured } = buildRefreshClick(ai, vi.fn(() =>
            Promise.reject(new AIProviderError('provider', 'Invalid API key', 401))));
        noticeRecords.length = 0;
        await captured.click!();
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(noticeRecords[0].message).toContain('Invalid API key');
    });

    it('shows a persistent error for a generic failure', async () => {
        const ai = makeAI();
        const { captured } = buildRefreshClick(ai, vi.fn(() => Promise.reject(new Error('boom'))));
        noticeRecords.length = 0;
        await captured.click!();
        expect(noticeRecords).toHaveLength(1);
        expect(noticeRecords[0].timeout).toBe(0);
        expect(noticeRecords[0].classes).toEqual(['youtnote-plugin__notice-error']);
        expect(noticeRecords[0].message).toBe('boom');
    });

    it('shows no notice when the refresh is cancelled', async () => {
        const ai = makeAI();
        const { captured, saveDataState, button } = buildRefreshClick(ai, vi.fn(() =>
            Promise.reject(new AIProviderError('cancelled', 'The request was cancelled.'))));
        noticeRecords.length = 0;
        await captured.click!();
        expect(saveDataState).not.toHaveBeenCalled();
        expect(noticeRecords).toHaveLength(0);
        expect((button.setDisabled.mock.calls as unknown as boolean[][]).at(-1)?.[0]).toBe(false);
        expect((button.setButtonText.mock.calls as unknown as string[][]).at(-1)?.[0]).toBe('Refresh models');
    });

    it.each([
        { name: 'success', listAIModels: () => Promise.resolve(['m1']), label: 'Refresh models', pending: 'Refreshing…' },
        { name: 'failure', listAIModels: () => Promise.reject(new Error('boom')), label: 'Refresh models', pending: 'Refreshing…' },
    ])('restores the button after a $name refresh', async ({ listAIModels, label, pending }) => {
        const ai = makeAI();
        const { captured, button } = buildRefreshClick(ai, vi.fn(listAIModels));
        await captured.click!();
        const texts = (button.setButtonText.mock.calls as unknown as string[][]).map(call => call[0]);
        expect(texts).toContain(pending);
        expect(texts[texts.length - 1]).toBe(label);
        expect((button.setDisabled.mock.calls as unknown as boolean[][]).at(-1)?.[0]).toBe(false);
    });

    it('restores the Test connection label for a custom provider', async () => {
        const ai = makeAI(aiSettings => {
            aiSettings.provider = 'custom';
            aiSettings.models.custom = 'llama';
            aiSettings.customBaseUrl = 'http://localhost:11434/v1';
        });
        const { captured, button } = buildRefreshClick(ai, vi.fn(() => Promise.resolve(['llama'])));
        await captured.click!();
        const texts = (button.setButtonText.mock.calls as unknown as string[][]).map(call => call[0]);
        expect(texts).toContain('Testing…');
        expect(texts[texts.length - 1]).toBe('Test connection');
        expect((button.setDisabled.mock.calls as unknown as boolean[][]).at(-1)?.[0]).toBe(false);
    });
});

describe('URI scheme guide link', () => {
    it('points the settings guide link at the shared docs URL', () => {
        const links: string[] = [];
        vi.stubGlobal('createFragment', (callback: (frag: {
            appendText(text: string): void;
            createEl(tag: string, options?: { attr?: Record<string, string> }): unknown;
        }) => void) => {
            callback({
                appendText: vi.fn(),
                createEl: (tag: string, options?: { attr?: Record<string, string> }) => {
                    if (tag === 'a') links.push(options?.attr?.href ?? '');
                    return {};
                },
            });
            return {};
        });
        try {
            const tab = new YoutnoteSettingTab(
                {} as never,
                { settings: DEFAULT_SETTINGS } as never,
            );
            tab.getSettingDefinitions();
            expect(links).toHaveLength(1);
            expect(links[0]).toBe(URI_SCHEME_GUIDE_URL);
            expect(new URL(links[0]).pathname)
                .toBe(`/khaldevmedia/obsidian-youtnote/blob/${GITHUB_DOCS_BRANCH}/docs/uri-scheme-guide.md`);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
