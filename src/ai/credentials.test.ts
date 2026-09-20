import { describe, expect, it, vi } from 'vitest';
import { migrateLegacyAICredentials } from './credentials';
import type { AISecretStorage } from './credentials';

function makeStorage(overrides: Partial<AISecretStorage> = {}) {
    const store = new Map<string, string>();
    const setSecret = vi.fn((id: string, secret: string) => {
        store.set(id, secret);
    });
    const getSecret = vi.fn((id: string) => (store.has(id) ? store.get(id) ?? null : null));
    const storage: AISecretStorage = { setSecret, getSecret, ...overrides };
    return { storage, store, setSecret, getSecret };
}

describe('migrateLegacyAICredentials', () => {
    it('migrates a plaintext key under settings, verifies it, deletes it, and records the secret name', () => {
        const { storage, store, setSecret } = makeStorage();
        const data: Record<string, unknown> = { settings: { openAiApiKey: 'sk-test-123' } };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual(['openai']);
        expect(result.failures).toEqual([]);
        expect(result.changed).toBe(true);
        expect(setSecret).toHaveBeenCalledWith('youtnote-openai-api-key', 'sk-test-123');
        expect(store.get('youtnote-openai-api-key')).toBe('sk-test-123');
        expect(data.settings).toEqual({ ai: { secretNames: { openai: 'youtnote-openai-api-key' } } });
    });

    it('migrates plaintext keys stored at the data root', () => {
        const { storage } = makeStorage();
        const data: Record<string, unknown> = { anthropicApiKey: 'sk-ant' };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual(['anthropic']);
        expect(result.changed).toBe(true);
        expect(data.anthropicApiKey).toBeUndefined();
        const settings = data.settings as Record<string, unknown>;
        expect((settings.ai as Record<string, unknown>).secretNames)
            .toEqual({ anthropic: 'youtnote-anthropic-api-key' });
    });

    it('maps every legacy alias to its provider', () => {
        const { storage, store } = makeStorage();
        const data: Record<string, unknown> = {
            settings: {
                openAIApiKey: 'k1',
                openaiApiKey: 'k1',
                geminiApiKey: 'k2',
                customApiKey: 'k3',
            },
        };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual(['openai', 'google', 'custom']);
        expect(result.failures).toEqual([]);
        expect(store.get('youtnote-google-api-key')).toBe('k2');
        expect(store.get('youtnote-custom-api-key')).toBe('k3');
        const settings = data.settings as Record<string, unknown>;
        expect(settings).not.toHaveProperty('openAIApiKey');
        expect(settings).not.toHaveProperty('openaiApiKey');
        expect(settings).not.toHaveProperty('geminiApiKey');
        expect(settings).not.toHaveProperty('customApiKey');
    });

    it('reuses an existing configured secret name instead of the fallback', () => {
        const { storage, setSecret } = makeStorage();
        const data: Record<string, unknown> = {
            settings: {
                openAiApiKey: 'sk-existing',
                ai: { secretNames: { openai: 'my-openai-secret' } },
            },
        };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual(['openai']);
        expect(setSecret).toHaveBeenCalledWith('my-openai-secret', 'sk-existing');
        const settings = data.settings as Record<string, unknown>;
        expect((settings.ai as Record<string, unknown>).secretNames)
            .toEqual({ openai: 'my-openai-secret' });
    });

    it('leaves plaintext intact and records a failure when setSecret throws', () => {
        const { storage } = makeStorage({
            setSecret: vi.fn(() => {
                throw new Error('keychain unavailable');
            }),
        });
        const data: Record<string, unknown> = { settings: { openAiApiKey: 'sk-keep-me' } };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual([]);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('openai');
        expect(result.failures[0]).not.toContain('sk-keep-me');
        expect(result.changed).toBe(false);
        expect((data.settings as Record<string, unknown>).openAiApiKey).toBe('sk-keep-me');
    });

    it('leaves plaintext intact and records a failure when readback mismatches', () => {
        const { storage } = makeStorage({
            getSecret: vi.fn(() => 'different-value'),
        });
        const data: Record<string, unknown> = { settings: { openAiApiKey: 'sk-verify-me' } };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual([]);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).not.toContain('sk-verify-me');
        expect(result.changed).toBe(false);
        expect((data.settings as Record<string, unknown>).openAiApiKey).toBe('sk-verify-me');
    });

    it('does not migrate or delete when aliases hold conflicting values', () => {
        const { storage, setSecret } = makeStorage();
        const data: Record<string, unknown> = {
            openAiApiKey: 'sk-one',
            settings: { openaiApiKey: 'sk-two' },
        };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual([]);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toContain('openai');
        expect(result.failures[0]).not.toContain('sk-one');
        expect(result.failures[0]).not.toContain('sk-two');
        expect(result.changed).toBe(false);
        expect(setSecret).not.toHaveBeenCalled();
        expect(data.openAiApiKey).toBe('sk-one');
        expect((data.settings as Record<string, unknown>).openaiApiKey).toBe('sk-two');
    });

    it('migrates when duplicate aliases hold the same value and deletes all of them', () => {
        const { storage } = makeStorage();
        const data: Record<string, unknown> = {
            openAiApiKey: 'same-key',
            settings: { openaiApiKey: 'same-key' },
        };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result.migrated).toEqual(['openai']);
        expect(result.failures).toEqual([]);
        expect(data.openAiApiKey).toBeUndefined();
        const settings = data.settings as Record<string, unknown>;
        expect(settings.openaiApiKey).toBeUndefined();
    });

    it('ignores blank values and data without legacy fields', () => {
        const { storage, setSecret } = makeStorage();
        const data: Record<string, unknown> = { settings: { openAiApiKey: '  ' } };

        const result = migrateLegacyAICredentials(data, storage);

        expect(result).toEqual({ migrated: [], failures: [], changed: false });
        expect(setSecret).not.toHaveBeenCalled();
        expect((data.settings as Record<string, unknown>).openAiApiKey).toBe('  ');
    });
});
