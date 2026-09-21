import { App, Modal } from 'obsidian';
import { ExportOptions } from '../types';
import type { AIGenerationDialogOptions } from '../types';

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

export class AIGenerationModal extends BaseModal {
    private hasExistingNotes: boolean;
    private hasExistingGeneralNote: boolean;
    private onGenerate: (options: AIGenerationDialogOptions) => void | Promise<void>;
    private instructionsEl!: HTMLTextAreaElement;
    private maxNotesEl!: HTMLInputElement;
    private generalNoteInput!: HTMLInputElement;
    private generalNoteModeEl: HTMLElement | null = null;
    private generalNotePreservedEl: HTMLElement | null = null;
    private appendGeneralNoteInput: HTMLInputElement | null = null;
    private addModeInput: HTMLInputElement | null = null;
    private replaceModeInput: HTMLInputElement | null = null;
    private generateBtn!: HTMLButtonElement;

    constructor(
        app: App,
        hasExistingNotes: boolean,
        hasExistingGeneralNote: boolean,
        onGenerate: (options: AIGenerationDialogOptions) => void | Promise<void>
    ) {
        super(app, 'Generate notes with AI', 'All fields below are optional.');
        this.hasExistingNotes = hasExistingNotes;
        this.hasExistingGeneralNote = hasExistingGeneralNote;
        this.onGenerate = onGenerate;
    }

    protected renderContent(contentEl: HTMLElement): void {
        const containerEl = contentEl.createDiv({ cls: 'youtnote-plugin__ai-generation' });

        const instructionsField = containerEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-field' });
        instructionsField.createSpan({ cls: 'youtnote-plugin__ai-generation-label', text: 'Custom instructions' });
        this.instructionsEl = instructionsField.createEl('textarea', {
            cls: 'youtnote-plugin__ai-generation-textarea',
            attr: { placeholder: 'E.g. Focus on the key takeaways and practical steps' },
        });

        const maxNotesField = containerEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-field' });
        maxNotesField.createSpan({ cls: 'youtnote-plugin__ai-generation-label', text: 'Maximum notes' });
        this.maxNotesEl = maxNotesField.createEl('input', {
            cls: 'youtnote-plugin__ai-generation-number',
            attr: { type: 'number', min: '1', step: '1' },
        });
        this.maxNotesEl.addEventListener('input', () => {
            this.updateGenerateDisabled();
        });

        const generalNoteSection = containerEl.createDiv({ cls: 'youtnote-plugin__ai-generation-section' });
        generalNoteSection.createDiv({
            cls: 'youtnote-plugin__ai-generation-section-title',
            text: 'General note',
        });
        const generalNoteLabel = generalNoteSection.createEl('label', { cls: 'youtnote-plugin__ai-generation-radio' });
        this.generalNoteInput = generalNoteLabel.createEl('input', { attr: { type: 'checkbox' } });
        this.generalNoteInput.checked = true;
        generalNoteLabel.createSpan({ text: 'Include a general note' });

        if (this.hasExistingGeneralNote) {
            this.generalNoteModeEl = generalNoteSection.createDiv({
                cls: 'youtnote-plugin__ai-generation-mode youtnote-plugin__ai-generation-general-options',
            });

            const replaceGeneralLabel = this.generalNoteModeEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-radio' });
            const replaceGeneralInput = replaceGeneralLabel.createEl('input', {
                attr: { type: 'radio', name: 'youtnote-ai-general-note-mode', value: 'replace' },
            });
            replaceGeneralInput.checked = true;
            replaceGeneralLabel.createSpan({ text: 'Replace existing note' });

            const appendGeneralLabel = this.generalNoteModeEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-radio' });
            this.appendGeneralNoteInput = appendGeneralLabel.createEl('input', {
                attr: { type: 'radio', name: 'youtnote-ai-general-note-mode', value: 'append' },
            });
            appendGeneralLabel.createSpan({ text: 'Append to existing note' });

            this.generalNotePreservedEl = generalNoteSection.createDiv({
                cls: 'youtnote-plugin__ai-generation-general-preserved',
                text: 'Existing general note will be preserved.',
            });
            this.generalNotePreservedEl.hidden = true;

            this.generalNoteInput.addEventListener('change', () => {
                const includeGeneralNote = this.generalNoteInput.checked;
                if (this.generalNoteModeEl) {
                    this.generalNoteModeEl.hidden = !includeGeneralNote;
                }
                if (this.generalNotePreservedEl) {
                    this.generalNotePreservedEl.hidden = includeGeneralNote;
                }
            });
        }

        if (this.hasExistingNotes) {
            const modeEl = containerEl.createDiv({
                cls: 'youtnote-plugin__ai-generation-section youtnote-plugin__ai-generation-mode',
            });
            modeEl.createDiv({
                cls: 'youtnote-plugin__ai-generation-section-title',
                text: 'Timestamped notes',
            });

            const addLabel = modeEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-radio' });
            this.addModeInput = addLabel.createEl('input', {
                attr: { type: 'radio', name: 'youtnote-ai-generation-mode', value: 'append' },
            });
            this.addModeInput.checked = true;
            addLabel.createSpan({ text: 'Add to existing notes' });

            modeEl.createDiv({
                cls: 'youtnote-plugin__ai-generation-warning',
                text: 'Adding notes can create duplicate timestamps. You can use Merge duplicates afterward.',
            });

            const replaceLabel = modeEl.createEl('label', { cls: 'youtnote-plugin__ai-generation-radio' });
            this.replaceModeInput = replaceLabel.createEl('input', {
                attr: { type: 'radio', name: 'youtnote-ai-generation-mode', value: 'replace' },
            });
            replaceLabel.createSpan({ text: 'Replace existing notes' });
        }
    }

    private isMaxNotesValid(): boolean {
        const raw = this.maxNotesEl.value.trim();
        if (raw === '') return true;
        const parsed = Number(raw);
        return Number.isInteger(parsed) && parsed > 0;
    }

    private updateGenerateDisabled(): void {
        if (this.generateBtn) {
            this.generateBtn.disabled = !this.isMaxNotesValid();
        }
    }

    private buildOptions(): AIGenerationDialogOptions {
        const options: AIGenerationDialogOptions = {
            customInstructions: this.instructionsEl.value.trim(),
            includeGeneralNote: this.generalNoteInput.checked,
            generalNoteMode: this.appendGeneralNoteInput?.checked ? 'append' : 'replace',
            mode: 'replace',
        };
        if (this.hasExistingNotes && this.addModeInput?.checked) {
            options.mode = 'append';
        }
        const raw = this.maxNotesEl.value.trim();
        const parsed = Number(raw);
        if (raw !== '' && Number.isInteger(parsed) && parsed > 0) {
            options.maxNotes = parsed;
        }
        return options;
    }

    protected renderButtons(buttonsEl: HTMLElement): void {
        this.createButton(
            buttonsEl,
            'Cancel',
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--secondary'
        );

        this.generateBtn = this.createButton(
            buttonsEl,
            'Generate',
            'youtnote-plugin__modal-button youtnote-plugin__modal-button--primary',
            () => this.onGenerate(this.buildOptions()),
            true
        );

        this.updateGenerateDisabled();
    }
}

export type AIGenerationProgressPhase = 'fetching-transcript' | 'generating-notes';

export class AIGenerationProgressModal extends Modal {
    private statusEl: HTMLElement | null = null;
    private didFinish = false;

    constructor(
        app: App,
        private phase: AIGenerationProgressPhase,
        private readonly onCancel: () => void,
    ) {
        super(app);
    }

    setPhase(phase: AIGenerationProgressPhase): void {
        this.phase = phase;
        this.statusEl?.setText(this.getStatusText());
    }

    finish(): void {
        if (this.didFinish) return;
        this.didFinish = true;
        this.close();
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('youtnote-plugin__ai-progress-modal');
        this.statusEl = contentEl.createDiv({
            cls: 'youtnote-plugin__ai-progress-modal-status',
            text: this.getStatusText(),
            attr: { role: 'status', 'aria-live': 'polite' },
        });
        const indicatorEl = contentEl.createDiv({
            cls: 'youtnote-plugin__ai-progress-modal-indicator',
            attr: { 'aria-hidden': 'true' },
        });
        indicatorEl.createDiv({ cls: 'youtnote-plugin__dot-pulse' });
        const buttonsEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-buttons youtnote-plugin__ai-progress-modal-buttons' });
        const cancelButton = buttonsEl.createEl('button', {
            text: 'Cancel',
            cls: 'youtnote-plugin__modal-button youtnote-plugin__modal-button--secondary',
        });
        cancelButton.addEventListener('click', () => this.close());
        cancelButton.focus();
    }

    onClose(): void {
        this.contentEl.empty();
        this.statusEl = null;
        if (!this.didFinish) {
            this.onCancel();
        }
    }

    private getStatusText(): string {
        return this.phase === 'fetching-transcript'
            ? 'Fetching transcript for AI'
            : 'Generating notes';
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
