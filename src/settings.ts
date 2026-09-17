import { App, PluginSettingTab, Setting } from "obsidian";
import YoutnotePlugin from "./main";
import { PluginSettings } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	autoplayOnNoteSelect: false,
	singleExpandMode: true,
	newLineTrigger: 'shift+enter',
	persistExpandedState: false,
	openExportedFile: true,
	showNoteStats: true,
	pinOnPhone: false,
	uriSchemeEnabled: false,
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
	'pinOnPhone' | 'autoplayOnNoteSelect' | 'singleExpandMode' | 'persistExpandedState' | 'openExportedFile' | 'showNoteStats' | 'uriSchemeEnabled'
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

type SettingItemDef = ToggleDef | DropdownDef;

interface SettingGroupDef {
	heading: string;
	subtitle?: string;
	items: SettingItemDef[];
}

const URI_SCHEME_GUIDE_URL = 'https://github.com/khaldevmedia/obsidian-youtnote/blob/feature/uri-scheme/docs/uri-scheme-guide.md';

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

	// Fallback for Obsidian < 1.13.0. On 1.13.0+ the framework renders from
	// getSettingDefinitions() and never calls display().
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const persistAndRefresh = async () => {
			await this.plugin.saveDataState();
			this.plugin.refreshAllViews();
		};

		for (const group of SETTING_DEFINITIONS) {
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
		return SETTING_DEFINITIONS.map(group => ({
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
