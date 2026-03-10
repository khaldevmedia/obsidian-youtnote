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
	pinOnPhone: false
}

export class YoutnoteSettingTab extends PluginSettingTab {
	plugin: YoutnotePlugin;

	constructor(app: App, plugin: YoutnotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const persistAndRefresh = async () => {
			await this.plugin.saveDataState();
			this.plugin.refreshAllViews();
		};

		// Title
        new Setting(containerEl)
            .setName("Youtnote Plugin Settings")
            .setHeading();

		// Subtitle
		containerEl.createEl("p", {
			text: "Configure how the Youtnote plugin behaves in your vault."
		});

		const addToggleSetting = (
			name: string,
			desc: string,
			key: keyof Pick<
				PluginSettings,
				'pinOnPhone' | 'autoplayOnNoteSelect' | 'singleExpandMode' | 'persistExpandedState' | 'openExportedFile' | 'showNoteStats'
			>
		) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						await persistAndRefresh();
					}));
		};
		
		addToggleSetting(
			'Autoplay on note select',
			'Automatically play the video when clicking on a note timestamp.',
			'autoplayOnNoteSelect'
		);
	
		addToggleSetting(
			'Single expand mode',
			'Only allow one note to be expanded at a time. Expanding a note will collapse others.',
			'singleExpandMode'
		);

		new Setting(containerEl)
			.setName('New line trigger')
			.setDesc('Choose how to create a new line when editing notes.')
			.addDropdown(dropdown => dropdown
				.addOption('shift+enter', 'Shift+Enter (Enter to save)')
				.addOption('enter', 'Enter (Shift+Enter to save)')
				.setValue(this.plugin.settings.newLineTrigger)
				.onChange(async (value) => {
					this.plugin.settings.newLineTrigger = value as 'enter' | 'shift+enter';
					await persistAndRefresh();
				}));

		addToggleSetting(
			'Persist expanded state',
			'Remember which notes are expanded when switching between videos or reopening the file.',
			'persistExpandedState'
		);

		addToggleSetting(
			'Open exported file',
			'Automatically open the exported Markdown file in a new tab after creation.',
			'openExportedFile'
		);
	
		addToggleSetting(
			'Show note statistics',
			'Display word count and character count statistics in the note list header.',
			'showNoteStats'
		);

		addToggleSetting(
			'Pin video on phone (sticky)',
			'Keep the video player visible at the top while scrolling notes on mobile.',
			'pinOnPhone'
		);
	}
}
