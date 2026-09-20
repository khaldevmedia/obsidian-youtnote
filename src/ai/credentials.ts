import type { ConfiguredAIProviderId } from './types';

export interface AISecretStorage {
    setSecret(id: string, secret: string): void;
    getSecret(id: string): string | null;
}

export interface CredentialMigrationResult {
    migrated: ConfiguredAIProviderId[];
    failures: string[];
    changed: boolean;
}

const PROVIDER_IDS: ConfiguredAIProviderId[] = ['openai', 'anthropic', 'google', 'custom'];

const LEGACY_KEYS: Record<ConfiguredAIProviderId, string[]> = {
    openai: ['openAiApiKey', 'openAIApiKey', 'openaiApiKey'],
    anthropic: ['anthropicApiKey'],
    google: ['geminiApiKey', 'googleApiKey'],
    custom: ['customApiKey'],
};

const FALLBACK_SECRET_IDS: Record<ConfiguredAIProviderId, string> = {
    openai: 'youtnote-openai-api-key',
    anthropic: 'youtnote-anthropic-api-key',
    google: 'youtnote-google-api-key',
    custom: 'youtnote-custom-api-key',
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureRecord(container: Record<string, unknown>, key: string): Record<string, unknown> {
    const existing = container[key];
    if (isRecord(existing)) {
        return existing;
    }
    const created: Record<string, unknown> = {};
    container[key] = created;
    return created;
}

export function migrateLegacyAICredentials(
    data: Record<string, unknown>,
    storage: AISecretStorage,
): CredentialMigrationResult {
    const migrated: ConfiguredAIProviderId[] = [];
    const failures: string[] = [];
    let changed = false;

    const locations: Record<string, unknown>[] = [data];
    if (isRecord(data.settings)) {
        locations.push(data.settings);
    }

    const existingSecretNames =
        isRecord(data.settings) && isRecord(data.settings.ai) && isRecord(data.settings.ai.secretNames)
            ? data.settings.ai.secretNames
            : undefined;

    for (const provider of PROVIDER_IDS) {
        const found: { location: Record<string, unknown>; key: string; value: string }[] = [];
        for (const location of locations) {
            for (const key of LEGACY_KEYS[provider]) {
                const value = location[key];
                if (typeof value === 'string' && value.trim()) {
                    found.push({ location, key, value });
                }
            }
        }
        if (found.length === 0) {
            continue;
        }
        if (new Set(found.map(entry => entry.value)).size > 1) {
            failures.push(`${provider}: multiple conflicting legacy API keys were found; none were migrated`);
            continue;
        }

        const existingName = existingSecretNames?.[provider];
        const secretId = typeof existingName === 'string' && existingName.trim()
            ? existingName
            : FALLBACK_SECRET_IDS[provider];
        const value = found[0].value;

        try {
            storage.setSecret(secretId, value);
        } catch {
            failures.push(`${provider}: the API key could not be stored in SecretStorage`);
            continue;
        }
        let verified = false;
        try {
            verified = storage.getSecret(secretId) === value;
        } catch {
            verified = false;
        }
        if (!verified) {
            failures.push(`${provider}: the stored API key could not be verified in SecretStorage`);
            continue;
        }

        for (const location of locations) {
            for (const key of LEGACY_KEYS[provider]) {
                if (key in location) {
                    delete location[key];
                }
            }
        }

        const aiSettings = ensureRecord(ensureRecord(data, 'settings'), 'ai');
        const secretNames = ensureRecord(aiSettings, 'secretNames');
        secretNames[provider] = secretId;

        migrated.push(provider);
        changed = true;
    }

    return { migrated, failures, changed };
}
