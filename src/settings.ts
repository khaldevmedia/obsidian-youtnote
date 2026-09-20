import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import YoutnotePlugin from "./main";
import { AISettings, PluginSettings } from "./types";
import type { AIProviderId, ConfiguredAIProviderId } from "./ai/types";

export const DEFAULT_SETTINGS: PluginSettings = {
	autoplayOnNoteSelect: false,
	singleExpandMode: true,
	newLineTrigger: 'shift+enter',
	persistExpandedState: false,
	openExportedFile: true,
	showNoteStats: true,
	switchToNotesAfterTranscriptNote: false,
	autoScrollTranscript: true,
	exportIncludeNotes: true,
	exportIncludeTranscripts: true,
	pinOnPhone: false,
	uriSchemeEnabled: false,
	ai: {
		enabled: false,
		provider: 'none',
		secretNames: { openai: '', anthropic: '', google: '', custom: '' },
		models: { openai: '', anthropic: '', google: '', custom: '' },
		availableModels: { openai: [], anthropic: [], google: [], custom: [] },
		customBaseUrl: '',
		hostedTimeoutSeconds: 120,
		customTimeoutSeconds: 300,
	},
}

const VALID_PROVIDER_IDS = new Set<string>(['none', 'openai', 'anthropic', 'google', 'custom']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeStringMap(raw: unknown): Record<ConfiguredAIProviderId, string> {
	const rec = isRecord(raw) ? raw : {};
	return {
		openai: typeof rec.openai === 'string' ? rec.openai : '',
		anthropic: typeof rec.anthropic === 'string' ? rec.anthropic : '',
		google: typeof rec.google === 'string' ? rec.google : '',
		custom: typeof rec.custom === 'string' ? rec.custom : '',
	};
}

function mergeModelLists(raw: unknown): Record<ConfiguredAIProviderId, string[]> {
	const rec = isRecord(raw) ? raw : {};
	const pick = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
	return {
		openai: pick(rec.openai),
		anthropic: pick(rec.anthropic),
		google: pick(rec.google),
		custom: pick(rec.custom),
	};
}

function positiveTimeout(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mergeAISettings(raw: unknown): AISettings {
	const src = isRecord(raw) ? raw : {};
	const defaults = DEFAULT_SETTINGS.ai;
	const provider = typeof src.provider === 'string' && VALID_PROVIDER_IDS.has(src.provider)
		? src.provider as AIProviderId
		: 'none';
	return {
		enabled: src.enabled === true,
		provider,
		secretNames: mergeStringMap(src.secretNames),
		models: mergeStringMap(src.models),
		availableModels: mergeModelLists(src.availableModels),
		customBaseUrl: typeof src.customBaseUrl === 'string' ? src.customBaseUrl : '',
		hostedTimeoutSeconds: positiveTimeout(src.hostedTimeoutSeconds, defaults.hostedTimeoutSeconds),
		customTimeoutSeconds: positiveTimeout(src.customTimeoutSeconds, defaults.customTimeoutSeconds),
	};
}

export function mergePluginSettings(raw: unknown): PluginSettings {
	const source = isRecord(raw) ? raw : {};
	const merged = Object.assign({}, DEFAULT_SETTINGS, source);
	merged.ai = mergeAISettings(source.ai);
	return merged;
}

// ─── Shared setting definitions ──────────────────────────────────────────
// This array is the single source of truth for all setting definitions.
// Both display() (legacy, Obsidian < 1.13.0) and getSettingDefinitions()
// (Obsidian 1.13.0+) consume it, so every setting's name, description, and
// control type only needs to be defined once.
//
// Trade-off: display() and getSettingDefinitions() expect different object
// shapes. Rather than forcing one shape, the shared array stores the raw
// data and each method transforms it into its expected output. This keeps
// strings DRY without breaking either API.
//
// The `desc` field can be a string or a function that returns a string or
// DocumentFragment. Functions are used when the desc needs to be built
// lazily (e.g. when it calls createFragment(), which must not run at module
// load time). Both display() and getSettingDefinitions() resolve function
// descs before rendering.

type ToggleKey = keyof Pick<
	PluginSettings,
	'pinOnPhone' | 'autoplayOnNoteSelect' | 'singleExpandMode' | 'persistExpandedState' | 'openExportedFile' | 'showNoteStats' | 'autoScrollTranscript' | 'switchToNotesAfterTranscriptNote' | 'uriSchemeEnabled'
>;

type Desc = string | (() => string | DocumentFragment);

interface ToggleDef {
	kind: 'toggle';
	name: string;
	desc: Desc;
	key: ToggleKey;
}

interface DropdownDef {
	kind: 'dropdown';
	name: string;
	desc: string;
	key: 'newLineTrigger';
	options: Record<string, string>;
}

interface CustomDef {
	kind: 'custom';
	name: string;
	desc: Desc;
	visible?: () => boolean;
	render: (setting: Setting) => void;
}

type SettingItemDef = ToggleDef | DropdownDef | CustomDef;

interface SettingGroupDef {
	heading: string;
	subtitle?: string;
	items: SettingItemDef[];
}

const URI_SCHEME_GUIDE_URL = 'https://github.com/khaldevmedia/obsidian-youtnote/blob/develop/docs/uri-scheme-guide.md';
const CUSTOM_BASE_URL_PLACEHOLDER = 'http://localhost:11434/v1';

function buildUriSchemeDesc(): DocumentFragment {
	return createFragment(frag => {
		frag.appendText('Lets external tools add videos and notes to youtnotes in your vault programmatically. While enabled, any link, webpage, or script that opens an obsidian://youtnote URI can add videos or notes to your open youtnote or create new youtnotes. Enable only if you use automation tools that rely on this feature. For a guide on using this feature, click ');
		frag.createEl('a', {
			text: 'Here',
			attr: { href: URI_SCHEME_GUIDE_URL },
		});
		frag.appendText('.');
	});
}

const SETTING_DEFINITIONS: SettingGroupDef[] = [
	{
		heading: 'Behavior',
		subtitle: 'Configure plugin behavior and display options in your vault.',
		items: [
			{
				kind: 'toggle',
				name: 'Autoplay on note select',
				desc: 'Automatically play the video when clicking on a note timestamp.',
				key: 'autoplayOnNoteSelect',
			},
			{
				kind: 'toggle',
				name: 'Single expand mode',
				desc: 'Only allow one note to be expanded at a time. Expanding a note will collapse others.',
				key: 'singleExpandMode',
			},
			{
				kind: 'dropdown',
				name: 'New line trigger',
				desc: 'Choose how to create a new line when editing notes.',
				key: 'newLineTrigger',
				options: {
					'shift+enter': 'Shift+Enter (Enter to save)',
					'enter': 'Enter (Shift+Enter to save)',
				},
			},
			{
				kind: 'toggle',
				name: 'Persist expanded state',
				desc: 'Remember which notes are expanded when switching between videos or reopening the file.',
				key: 'persistExpandedState',
			},
			{
				kind: 'toggle',
				name: 'Open exported file',
				desc: 'Automatically open the exported Markdown file in a new tab after creation.',
				key: 'openExportedFile',
			},
			{
				kind: 'toggle',
				name: 'Show note statistics',
				desc: 'Display word count and character count statistics in the note list header.',
				key: 'showNoteStats',
			},
			{
				kind: 'toggle',
				name: 'Auto-scroll transcript during playback',
				desc: 'Keep the active caption centered while the video plays. Turn this off to stop auto-scrolling. The sync button remains available.',
				key: 'autoScrollTranscript',
			},
			{
				kind: 'toggle',
				name: 'Switch to notes after creating a note from transcript',
				desc: 'When creating a note from a transcript timestamp, go back to the note list and select the new note. When off, the note is added without leaving the transcript view.',
				key: 'switchToNotesAfterTranscriptNote',
			},
			{
				kind: 'toggle',
				name: 'Pin video on phone (sticky)',
				desc: 'Keep the video player visible at the top while scrolling notes on mobile.',
				key: 'pinOnPhone',
			},
		],
	},
	{
		heading: 'Advanced',
		items: [
			{
				kind: 'toggle',
				name: 'Enable uri scheme',
				// Lazy: createFragment must not run at module load time, only
				// when the setting is actually rendered.
				desc: buildUriSchemeDesc,
				key: 'uriSchemeEnabled',
			},
		],
	},
];

/** Resolves a Desc to a string or DocumentFragment, calling it if it's a function. */
function resolveDesc(desc: Desc): string | DocumentFragment {
	return typeof desc === 'function' ? desc() : desc;
}

export class YoutnoteSettingTab extends PluginSettingTab {
	plugin: YoutnotePlugin;

	constructor(app: App, plugin: YoutnotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private settingGroups(): SettingGroupDef[] {
		const groups = SETTING_DEFINITIONS.slice();
		groups.splice(1, 0, this.buildAIGroup());
		return groups;
	}

	private rerenderSettings(): void {
		const self = this as unknown as { update?: () => void; refresh?: () => void };
		if (typeof self.update === 'function') {
			self.update();
			return;
		}
		if (typeof self.refresh === 'function') {
			self.refresh();
			return;
		}
		this.display();
	}

	private buildAIGroup(): SettingGroupDef {
		const plugin = this.plugin;
		const ai = (): AISettings => plugin.settings.ai;
		const persist = async (): Promise<void> => {
			await plugin.saveDataState();
			plugin.refreshAllViews();
		};
		const rerender = (): void => {
			this.rerenderSettings();
		};
		const providerId = (): ConfiguredAIProviderId | null => {
			const provider = ai().provider;
			return provider === 'none' ? null : provider;
		};
		const isCustom = (): boolean => ai().provider === 'custom';
		const showProviderRows = (): boolean => ai().enabled && providerId() !== null;

		return {
			heading: 'AI',
			items: [
				{
					kind: 'custom',
					name: 'Enable AI-generated notes',
					desc: 'Generate timestamped notes from a video transcript using an AI provider.',
					render: (setting) => {
						setting.addToggle(toggle => toggle
							.setValue(ai().enabled)
							.onChange(async (value) => {
								ai().enabled = value;
								await persist();
								rerender();
							}));
					},
				},
				{
					kind: 'custom',
					name: 'Provider',
					desc: 'Choose which AI provider generates notes.',
					visible: () => ai().enabled,
					render: (setting) => {
						setting.addDropdown(dropdown => dropdown
							.addOptions({
								none: 'No provider configured',
								openai: 'OpenAI',
								anthropic: 'Anthropic',
								google: 'Google (Gemini)',
								custom: 'Custom (OpenAI-compatible)',
							})
							.setValue(ai().provider)
							.onChange(async (value) => {
								ai().provider = value as AIProviderId;
								await persist();
								rerender();
							}));
					},
				},
				{
					kind: 'custom',
					name: 'API key secret',
					desc: 'Required for hosted providers. Optional for Custom, where local OpenAI-compatible servers often need no API key. Select or create a secret in Obsidian Keychain.',
					visible: showProviderRows,
					render: (setting) => {
						const id = providerId();
						if (!id) {
							return;
						}
						setting.addComponent(el => new SecretComponent(this.app, el)
							.setValue(ai().secretNames[id])
							.onChange(async (value) => {
								ai().secretNames[id] = value;
								await persist();
							}));
					},
				},
				{
					kind: 'custom',
					name: 'Base URL',
					desc: 'Base URL of the OpenAI-compatible API endpoint, for example a local server. Self-signed TLS certificates are not supported.',
					visible: () => ai().enabled && isCustom(),
					render: (setting) => {
						setting.addText(text => {
							text.setPlaceholder(CUSTOM_BASE_URL_PLACEHOLDER)
								.setValue(ai().customBaseUrl)
								.onChange(async (value) => {
									if (value === ai().customBaseUrl) {
										return;
									}
									ai().customBaseUrl = value;
									ai().models.custom = '';
									ai().availableModels.custom = [];
									await persist();
								});
							text.inputEl.addEventListener('blur', () => {
								rerender();
							});
						});
					},
				},
				{
					kind: 'custom',
					name: 'Unencrypted connection',
					desc: 'This connection is unencrypted. Plain HTTP may not work on iOS.',
					visible: () => ai().enabled && isCustom() && ai().customBaseUrl.trim().toLowerCase().startsWith('http://'),
					render: (setting) => {
						setting.setClass('youtnote-plugin__settings-warning');
					},
				},
				{
					kind: 'custom',
					name: 'Model',
					desc: 'Select a fetched model, or enter a model ID directly when using Custom.',
					visible: showProviderRows,
					render: (setting) => {
						const id = providerId();
						if (!id) {
							return;
						}
						if (id === 'custom') {
							setting.addText(text => {
								text.setPlaceholder('Model ID')
									.setValue(ai().models.custom)
									.onChange(async (value) => {
										ai().models.custom = value;
										await persist();
									});
								const datalist = setting.controlEl.createEl('datalist', { attr: { id: 'youtnote-ai-custom-models' } });
								for (const model of ai().availableModels.custom) {
									datalist.createEl('option', { attr: { value: model } });
								}
								text.inputEl.setAttribute('list', 'youtnote-ai-custom-models');
							});
							return;
						}
						setting.addDropdown(dropdown => {
							const cached = ai().availableModels[id];
							const current = ai().models[id];
							dropdown.addOption('', 'Refresh models to load available models');
							for (const model of cached) {
								dropdown.addOption(model, model);
							}
							if (current && !cached.includes(current)) {
								dropdown.addOption(current, current);
							}
							dropdown.setValue(current).onChange(async (value) => {
								ai().models[id] = value;
								await persist();
							});
						});
					},
				},
				{
					kind: 'custom',
					name: 'Model list',
					desc: 'Fetch the models available for the selected provider.',
					visible: showProviderRows,
					render: (setting) => {
						const id = providerId();
						if (!id) {
							return;
						}
						const customProvider = id === 'custom';
						const label = customProvider ? 'Test connection' : 'Refresh models';
						const pendingLabel = customProvider ? 'Testing…' : 'Refreshing…';
						setting.addButton(button => {
							button.setButtonText(label).onClick(async () => {
								button.setDisabled(true).setButtonText(pendingLabel);
								try {
									const models = await plugin.listAIModels(id);
									ai().availableModels[id] = models;
									if (!models.includes(ai().models[id])) {
										ai().models[id] = models[0];
									}
									await persist();
									new Notice(`Loaded ${models.length} model${models.length === 1 ? '' : 's'}.`);
									rerender();
								} catch (error) {
									new Notice(error instanceof Error ? error.message : String(error));
								} finally {
									button.setDisabled(false).setButtonText(label);
								}
							});
						});
					},
				},
				{
					kind: 'custom',
					name: 'Request timeout',
					desc: 'Seconds before the request times out. Custom endpoints default higher because local models can be slower.',
					visible: showProviderRows,
					render: (setting) => {
						const id = providerId();
						if (!id) {
							return;
						}
						const key = id === 'custom' ? 'customTimeoutSeconds' as const : 'hostedTimeoutSeconds' as const;
						setting.addText(text => {
							text.setPlaceholder(String(DEFAULT_SETTINGS.ai[key]))
								.setValue(String(ai()[key]))
								.onChange(async (value) => {
									const parsed = Number(value);
									if (!Number.isFinite(parsed) || parsed <= 0) {
										return;
									}
									ai()[key] = parsed;
									await persist();
								});
							text.inputEl.type = 'number';
							text.inputEl.min = '1';
						});
					},
				},
			],
		};
	}

	// Fallback for Obsidian < 1.13.0. On 1.13.0+ the framework renders from
	// getSettingDefinitions() and never calls display().
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const persistAndRefresh = async () => {
			await this.plugin.saveDataState();
			this.plugin.refreshAllViews();
		};

		for (const group of this.settingGroups()) {
			new Setting(containerEl)
				.setName(group.heading)
				.setHeading();

			if (group.subtitle) {
				containerEl.createEl("p", { text: group.subtitle });
			}

			for (const item of group.items) {
				if (item.kind === 'toggle') {
					new Setting(containerEl)
						.setName(item.name)
						.setDesc(resolveDesc(item.desc))
						.addToggle(toggle => toggle
							.setValue(this.plugin.settings[item.key])
							.onChange(async (value) => {
								this.plugin.settings[item.key] = value;
								await persistAndRefresh();
							}));
				} else if (item.kind === 'dropdown') {
					new Setting(containerEl)
						.setName(item.name)
						.setDesc(item.desc)
						.addDropdown(dropdown => {
							for (const [value, label] of Object.entries(item.options)) {
								dropdown.addOption(value, label);
							}
							dropdown
								.setValue(this.plugin.settings[item.key])
								.onChange(async (value) => {
									this.plugin.settings[item.key] = value as 'enter' | 'shift+enter';
									await persistAndRefresh();
								});
						});
				} else if (item.kind === 'custom') {
					if (item.visible !== undefined && !item.visible()) {
						continue;
					}
					const setting = new Setting(containerEl)
						.setName(item.name)
						.setDesc(resolveDesc(item.desc));
					item.render(setting);
				}
			}
		}
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveDataState();
		this.plugin.refreshAllViews();
	}

	getSettingDefinitions() {
		// Transform the shared definitions into the shape expected by the
		// Obsidian 1.13.0+ declarative settings API: groups have `type: 'group'`,
		// items have a `control` property with `type` and `key`.
		return this.settingGroups().map(group => ({
			type: 'group' as const,
			heading: group.heading,
			items: group.items.map(item => {
				if (item.kind === 'toggle') {
					return {
						name: item.name,
						desc: resolveDesc(item.desc),
						control: { type: 'toggle' as const, key: item.key },
					};
				}
				if (item.kind === 'custom') {
					const def: {
						name: string;
						desc: string | DocumentFragment;
						render: (setting: Setting) => void;
						visible?: () => boolean;
					} = {
						name: item.name,
						desc: resolveDesc(item.desc),
						render: item.render,
					};
					if (item.visible) {
						def.visible = item.visible;
					}
					return def;
				}
				return {
					name: item.name,
					desc: item.desc,
					control: {
						type: 'dropdown' as const,
						key: item.key,
						options: item.options,
					},
				};
			}),
		}));
	}
}
