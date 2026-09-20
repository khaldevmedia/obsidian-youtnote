import { App, Modal } from 'obsidian';
import { ExportOptions } from '../types';

export abstract class BaseModal extends Modal {
    protected title: string;
    protected message: string;

    constructor(app: App, title: string, message: string) {
        super(app);
        this.title = title;
        this.message = message;
    }

    protected abstract renderButtons(buttonsEl: HTMLElement): void;

    protected renderContent(_contentEl: HTMLElement): void {}

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.addClass('youtnote-plugin__base-modal');

        const titleEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-title' });
        titleEl.setText(this.title);

        const messageEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-message' });
        messageEl.setText(this.message);

        this.renderContent(contentEl);

        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons' });
        this.renderButtons(buttonsEl);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class AlertModal extends BaseModal {
    private buttonText: string;

    constructor(
        app: App,
        title: string,
        message: string,
        buttonText: string = 'OK'
    ) {
        super(app, title, message);
        this.buttonText = buttonText;
    }

    protected renderButtons(buttonsEl: HTMLElement): void {
        const okBtn = buttonsEl.createEl('button', {
            text: this.buttonText,
            cls: 'youtnote-plugin__alert-ok'
        });
        okBtn.addEventListener('click', () => {
            this.close();
        });
        okBtn.focus();
    }
}

export class ConfirmModal extends BaseModal {
    private onConfirm: () => void;
    private confirmText: string;
    private cancelText: string;

    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: () => void,
        confirmText: string = 'Confirm',
        cancelText: string = 'Cancel'
    ) {
        super(app, title, message);
        this.onConfirm = onConfirm;
        this.confirmText = confirmText;
        this.cancelText = cancelText;
    }

    protected renderButtons(buttonsEl: HTMLElement): void {
        const cancelBtn = buttonsEl.createEl('button', {
            text: this.cancelText,
            cls: 'youtnote-plugin__confirm-cancel'
        });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });
        
        const confirmBtn = buttonsEl.createEl('button', {
            text: this.confirmText,
            cls: 'youtnote-plugin__confirm-confirm mod-warning'
        });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });
        
        confirmBtn.focus();
    }
}

export class ExportOptionsModal extends BaseModal {
    private exportAllVideos: boolean;
    private options: ExportOptions;
    private onExport: (options: ExportOptions) => void | Promise<void>;
    private notesCheckbox!: HTMLInputElement;
    private transcriptsCheckbox!: HTMLInputElement;
    private exportBtn!: HTMLButtonElement;

    constructor(
        app: App,
        exportAllVideos: boolean,
        options: ExportOptions,
        onExport: (options: ExportOptions) => void | Promise<void>
    ) {
        super(
            app,
            exportAllVideos ? 'Export all videos' : 'Export selected video',
            'Choose what to include in the exported file.'
        );
        this.exportAllVideos = exportAllVideos;
        this.options = options;
        this.onExport = onExport;
    }

    protected renderContent(contentEl: HTMLElement): void {
        const containerEl = contentEl.createDiv({ cls: 'youtnote-plugin__export-options' });

        this.notesCheckbox = this.createCheckboxOption(containerEl, 'Notes', this.options.includeNotes);
        this.transcriptsCheckbox = this.createCheckboxOption(
            containerEl,
            this.exportAllVideos ? 'Transcripts' : 'Transcript',
            this.options.includeTranscripts
        );
    }

    private createCheckboxOption(containerEl: HTMLElement, label: string, checked: boolean): HTMLInputElement {
        const optionEl = containerEl.createEl('label', { cls: 'youtnote-plugin__export-option' });
        const checkbox = optionEl.createEl('input', { attr: { type: 'checkbox' } });
        checkbox.checked = checked;
        checkbox.addEventListener('change', () => {
            this.updateExportDisabled();
        });
        optionEl.createSpan({ text: label });
        return checkbox;
    }

    private updateExportDisabled(): void {
        if (this.exportBtn) {
            this.exportBtn.disabled = !this.notesCheckbox.checked && !this.transcriptsCheckbox.checked;
        }
    }

    protected renderButtons(buttonsEl: HTMLElement): void {
        const cancelBtn = buttonsEl.createEl('button', {
            text: 'Cancel',
            cls: 'youtnote-plugin__confirm-cancel'
        });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });

        this.exportBtn = buttonsEl.createEl('button', {
            text: 'Export',
            cls: 'youtnote-plugin__confirm-confirm'
        });
        this.exportBtn.addEventListener('click', () => {
            const options: ExportOptions = {
                includeNotes: this.notesCheckbox.checked,
                includeTranscripts: this.transcriptsCheckbox.checked,
            };
            void Promise.resolve()
                .then(() => this.onExport(options))
                .catch(err => {
                    console.error('Export failed:', err);
                });
            this.close();
        });

        this.updateExportDisabled();
        this.exportBtn.focus();
    }
}
