import { App, Modal } from 'obsidian';
import { ExportOptions } from '../types';

type ModalAction = () => void | Promise<void>;
type ConfirmButtonVariant = 'primary' | 'danger';

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

    protected createButton(
        buttonsEl: HTMLElement,
        text: string,
        classes: string,
        action?: ModalAction,
        autofocus: boolean = false
    ): HTMLButtonElement {
        const button = buttonsEl.createEl('button', { text, cls: classes });
        button.addEventListener('click', () => {
            if (action) {
                try {
                    void Promise.resolve(action()).catch(err => {
                        console.error('Modal action failed:', err);
                    });
                } catch (err) {
                    console.error('Modal action failed:', err);
                }
            }
            this.close();
        });
        if (autofocus) button.focus();
        return button;
    }

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
        this.createButton(
            buttonsEl,
            this.buttonText,
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--primary',
            undefined,
            true
        );
    }
}

export class ConfirmModal extends BaseModal {
    private onConfirm: () => void;
    private confirmText: string;
    private cancelText: string;
    private confirmVariant: ConfirmButtonVariant;

    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: () => void,
        confirmText: string = 'Confirm',
        cancelText: string = 'Cancel',
        confirmVariant: ConfirmButtonVariant = 'danger'
    ) {
        super(app, title, message);
        this.onConfirm = onConfirm;
        this.confirmText = confirmText;
        this.cancelText = cancelText;
        this.confirmVariant = confirmVariant;
    }

    protected renderButtons(buttonsEl: HTMLElement): void {
        this.createButton(
            buttonsEl,
            this.cancelText,
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--secondary'
        );

        const confirmClass = this.confirmVariant === 'danger'
            ? 'youtnote-plugin__modal-button--danger'
            : 'youtnote-plugin__modal-button--primary';

        this.createButton(
            buttonsEl,
            this.confirmText,
            `youtnote-plugin__modal-button ${confirmClass}`,
            this.onConfirm,
            true
        );
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
        this.createButton(
            buttonsEl,
            'Cancel',
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--secondary'
        );

        this.exportBtn = this.createButton(
            buttonsEl,
            'Export',
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--primary',
            () => this.onExport({
                includeNotes: this.notesCheckbox.checked,
                includeTranscripts: this.transcriptsCheckbox.checked,
            })
        );

        this.updateExportDisabled();
        this.exportBtn.focus();
    }
}
