import { App, Modal } from 'obsidian';

export abstract class BaseModal extends Modal {
    protected title: string;
    protected message: string;

    constructor(app: App, title: string, message: string) {
        super(app);
        this.title = title;
        this.message = message;
    }

    protected abstract renderButtons(buttonsEl: HTMLElement): void;

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.addClass('youtnote-plugin__base-modal');
        
        const titleEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-title' });
        titleEl.setText(this.title);
        
        const messageEl = contentEl.createDiv({ cls: 'youtnote-plugin__base-modal-message' });
        messageEl.setText(this.message);
        
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
