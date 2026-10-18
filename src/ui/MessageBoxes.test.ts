import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { AlertModal, ConfirmModal, LegacyFormatConversionModal, promptLegacyConversionDecision } from './MessageBoxes';
import type { LegacyConversionDecision } from './MessageBoxes';
import { GITHUB_DOCS_BRANCH, V2_FILE_FORMAT_MIGRATION_URL } from '../constants';
import { getLegacyBackupPath } from '../conversionBackup';

const { fakeEl } = vi.hoisted(() => {
    interface FakeEl {
        tag: string;
        cls: string;
        text: string;
        children: FakeEl[];
        listeners: Record<string, () => void>;
        focused: boolean;
        empty(): void;
        addClass(cls: string): void;
        createDiv(options?: { cls?: string; text?: string }): FakeEl;
        createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeEl;
        createSpan(options?: { text?: string; cls?: string }): FakeEl;
        appendText(text: string): void;
        setText(text: string): void;
        addEventListener(type: string, handler: () => void): void;
        contains(node: unknown): boolean;
        focus(): void;
        click(): void;
        findByAction(action: string): FakeEl | null;
        findByCls(cls: string): FakeEl | null;
        dataset: Record<string, string>;
        attr: Record<string, string>;
    }
    function fakeEl(): FakeEl {
        const el: FakeEl = {
            tag: 'div',
            cls: '',
            text: '',
            children: [],
            dataset: {},
            attr: {},
            listeners: {},
            focused: false,
            empty() {
                el.children = [];
            },
            addClass(cls) {
                el.cls = el.cls ? `${el.cls} ${cls}` : cls;
            },
            createDiv(options) {
                const child = fakeEl();
                child.cls = options?.cls ?? '';
                if (options?.text !== undefined) child.text = options.text;
                el.children.push(child);
                return child;
            },
            createEl(tag, options) {
                const child = fakeEl();
                child.tag = tag;
                child.text = options?.text ?? '';
                child.cls = options?.cls ?? '';
                child.attr = options?.attr ?? {};
                el.children.push(child);
                return child;
            },
            createSpan(options) {
                const child = fakeEl();
                child.tag = 'span';
                child.text = options?.text ?? '';
                child.cls = options?.cls ?? '';
                el.children.push(child);
                return child;
            },
            appendText(text) {
                el.text += text;
            },
            setText(text) {
                el.text = text;
            },
            addEventListener(type, handler) {
                el.listeners[type] = handler;
            },
            contains() {
                return true;
            },
            focus() {
                el.focused = true;
            },
            click() {
                el.listeners.click?.();
            },
            findByAction(action) {
                for (const child of el.children) {
                    if (child.dataset.youtnoteAction === action) return child;
                    const nested = child.findByAction(action);
                    if (nested) return nested;
                }
                return null;
            },
            findByCls(cls) {
                for (const child of el.children) {
                    if (child.cls.includes(cls)) return child;
                    const nested = child.findByCls(cls);
                    if (nested) return nested;
                }
                return null;
            },
        };
        return el;
    }
    return { fakeEl };
});

vi.mock('obsidian', () => {
    class FakeModal {
        contentEl = fakeEl();
        containerEl = fakeEl();
        modalEl = fakeEl();
        scope = { register: vi.fn() };
        shouldRestoreSelection = true;
        isOpen = false;
        constructor(public app: unknown) {}
        open(): void {
            this.isOpen = true;
            this.onOpen();
        }
        close(): void {
            if (!this.isOpen) return;
            this.isOpen = false;
            this.onClose();
        }
        onOpen(): void {}
        onClose(): void {}
    }
    return {
        Modal: FakeModal,
        App: class {},
        Component: class {},
        TFile: class {},
        Notice: class {},
    };
});

function unsafeCast<T>(value: unknown): T {
    return value as T;
}

const app = unsafeCast<App>({});

describe('LegacyFormatConversionModal', () => {
    it('renders modal regions and the supplied file name', () => {
        const fileName = 'my-notes.md';
        const modal = new LegacyFormatConversionModal(app, fileName);
        modal.open();
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const titleEl = contentEl.children.find(child => child.cls.includes('youtnote-plugin__base-modal-title'));
        const messageEl = contentEl.children.find(child => child.cls.includes('youtnote-plugin__base-modal-message'));
        const fileNameEl = contentEl.children.find(child => child.cls.includes('youtnote-plugin__base-modal-filename'));
        expect(titleEl).toBeDefined();
        expect(messageEl).toBeDefined();
        expect(fileNameEl).toBeDefined();
        expect(fileNameEl!.text).toContain(fileName);
        expect(fileNameEl!.children).toHaveLength(0);
    });

    it('renders a migration guide link immediately before the file name', async () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const guideIndex = contentEl.children.findIndex(child =>
            child.cls.includes('youtnote-plugin__conversion-guide-link'));
        const fileNameIndex = contentEl.children.findIndex(child =>
            child.cls.includes('youtnote-plugin__base-modal-filename'));
        expect(guideIndex).toBeGreaterThanOrEqual(0);
        expect(fileNameIndex).toBeGreaterThanOrEqual(0);
        expect(guideIndex).toBe(fileNameIndex - 1);
        const guideEl = contentEl.children[guideIndex];
        const anchor = guideEl.children.find(child => child.tag === 'a');
        expect(anchor).toBeDefined();
        expect(anchor!.cls).toContain('external-link');
        expect(anchor!.attr.href).toBe(V2_FILE_FORMAT_MIGRATION_URL);
        expect(new URL(anchor!.attr.href).pathname)
            .toBe(`/khaldevmedia/obsidian-youtnote/blob/${GITHUB_DOCS_BRANCH}/docs/v2-file-format-migration.md`);
        expect(anchor!.attr.target).toBe('_blank');
        expect(anchor!.attr.rel).toBe('noopener noreferrer');
        let settled = false;
        void modal.decision.then(() => { settled = true; });
        anchor!.click();
        await Promise.resolve();
        expect(unsafeCast<{ isOpen: boolean }>(modal).isOpen).toBe(true);
        expect(settled).toBe(false);
        const readOnlyButton = contentEl.findByAction('read-only');
        expect(readOnlyButton!.focused).toBe(true);
        modal.close();
        await expect(modal.decision).resolves.toBe('read-only');
    });

    it('resolves read-only when the focused read-only action button is clicked', async () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const readOnlyButton = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl).findByAction('read-only');
        expect(readOnlyButton).not.toBeNull();
        expect(readOnlyButton!.focused).toBe(true);
        readOnlyButton!.click();
        await expect(modal.decision).resolves.toBe('read-only');
    });

    it('resolves convert only when the convert action button is clicked', async () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const convertButton = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl).findByAction('convert');
        expect(convertButton).not.toBeNull();
        convertButton!.click();
        await expect(modal.decision).resolves.toEqual({ action: 'convert', createBackup: true });
    });

    const findBackupCheckbox = (modal: LegacyFormatConversionModal) => {
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const backupEl = contentEl.children.find(child => child.cls.includes('youtnote-plugin__conversion-backup'));
        expect(backupEl).toBeDefined();
        const label = backupEl!.children.find(child => child.tag === 'label');
        const input = label?.children.find(child => child.tag === 'input');
        expect(input).toBeDefined();
        return { backupEl: backupEl!, input: unsafeCast<FakeInput>(input!) };
    };
    interface FakeInput {
        checked: boolean;
        attr: Record<string, string>;
    }

    const findBackupFilenameSpan = (modal: LegacyFormatConversionModal) => {
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const descEl = contentEl.findByCls('youtnote-plugin__conversion-backup-desc');
        expect(descEl).not.toBeNull();
        const spans = descEl!.children.filter(child =>
            child.cls.includes('youtnote-plugin__conversion-backup-filename'));
        expect(spans).toHaveLength(1);
        expect(spans[0].tag).toBe('span');
        return spans[0];
    };

    it('checks the backup checkbox by default and shows the backup filename', () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const { input } = findBackupCheckbox(modal);
        expect(input.checked).toBe(true);
        expect(input.attr.type).toBe('checkbox');
        expect(findBackupFilenameSpan(modal).text).toBe(getLegacyBackupPath('a.md'));
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const backupIndex = contentEl.children.findIndex(child => child.cls.includes('youtnote-plugin__conversion-backup'));
        const guideIndex = contentEl.children.findIndex(child => child.cls.includes('youtnote-plugin__conversion-guide-link'));
        expect(backupIndex).toBeGreaterThanOrEqual(0);
        expect(backupIndex).toBeLessThan(guideIndex);
    });

    it('previews the exact backup name for a .md.md file name', () => {
        const modal = new LegacyFormatConversionModal(app, 'foo.md.md');
        modal.open();
        expect(findBackupFilenameSpan(modal).text).toBe(getLegacyBackupPath('foo.md.md'));
    });

    it('keeps the backup checkbox checked by default after another modal opted out', async () => {
        const first = new LegacyFormatConversionModal(app, 'a.md');
        first.open();
        findBackupCheckbox(first).input.checked = false;
        unsafeCast<ReturnType<typeof fakeEl>>(first.contentEl).findByAction('convert')!.click();
        await expect(first.decision).resolves.toEqual({ action: 'convert', createBackup: false });
        const second = new LegacyFormatConversionModal(app, 'a.md');
        second.open();
        expect(findBackupCheckbox(second).input.checked).toBe(true);
        second.close();
        await expect(second.decision).resolves.toBe('read-only');
    });

    it('resolves convert with createBackup false when the checkbox is unchecked', async () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const { input } = findBackupCheckbox(modal);
        input.checked = false;
        unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl).findByAction('convert')!.click();
        await expect(modal.decision).resolves.toEqual({ action: 'convert', createBackup: false });
    });

    it.each(['close', 'double-close'] as const)('resolves read-only exactly once on %s dismissal', async (kind) => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        const decisions: LegacyConversionDecision[] = [];
        void modal.decision.then(decision => decisions.push(decision));
        modal.open();
        modal.close();
        if (kind === 'double-close') {
            modal.onClose();
        }
        await modal.decision;
        await Promise.resolve();
        expect(decisions).toEqual(['read-only']);
    });

    it('helper opens the modal and resolves with its decision', async () => {
        const openSpy = vi.spyOn(LegacyFormatConversionModal.prototype, 'open')
            .mockImplementation(function (this: LegacyFormatConversionModal) {
                unsafeCast<{ isOpen: boolean; onOpen(): void }>(this).isOpen = true;
                this.onOpen();
            });
        try {
            const decision = promptLegacyConversionDecision(app, 'file.md');
            expect(openSpy).toHaveBeenCalledTimes(1);
            const modal = unsafeCast<LegacyFormatConversionModal>(openSpy.mock.contexts[0]);
            modal.close();
            await expect(decision).resolves.toBe('read-only');
        } finally {
            openSpy.mockRestore();
        }
    });

    it('closes the modal and resolves read-only when the signal aborts', async () => {
        const openSpy = vi.spyOn(LegacyFormatConversionModal.prototype, 'open')
            .mockImplementation(function (this: LegacyFormatConversionModal) {
                unsafeCast<{ isOpen: boolean; onOpen(): void }>(this).isOpen = true;
                this.onOpen();
            });
        try {
            const controller = new AbortController();
            const decision = promptLegacyConversionDecision(app, 'file.md', controller.signal);
            const modal = unsafeCast<LegacyFormatConversionModal & { isOpen: boolean }>(openSpy.mock.contexts[0]);
            expect(modal.isOpen).toBe(true);
            controller.abort();
            expect(modal.isOpen).toBe(false);
            await expect(decision).resolves.toBe('read-only');
        } finally {
            openSpy.mockRestore();
        }
    });

    it('resolves read-only without opening when the signal is already aborted', async () => {
        const openSpy = vi.spyOn(LegacyFormatConversionModal.prototype, 'open');
        try {
            const controller = new AbortController();
            controller.abort();
            await expect(promptLegacyConversionDecision(app, 'file.md', controller.signal))
                .resolves.toBe('read-only');
            expect(openSpy).not.toHaveBeenCalled();
        } finally {
            openSpy.mockRestore();
        }
    });

    it('renders a separate styled warning heading', () => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        modal.open();
        const messageEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl)
            .children.find(child => child.cls.includes('youtnote-plugin__conversion-message'));
        expect(messageEl).toBeDefined();
        expect(messageEl!.cls).toContain('youtnote-plugin__base-modal-message');
        const paragraphs = messageEl!.children.filter(child => child.tag === 'p');
        const headingParagraphs = paragraphs.filter(p =>
            p.children.some(child => child.cls.includes('youtnote-plugin__conversion-warning-heading')));
        expect(headingParagraphs).toHaveLength(1);
        const headingParagraph = headingParagraphs[0];
        expect(headingParagraph.children).toHaveLength(1);
        expect(headingParagraph.children[0].tag).toBe('strong');
        expect(headingParagraph.children[0].cls).toContain('youtnote-plugin__conversion-warning-heading');
    });

    const message = '<em>sample</em>';
    it.each([
        () => new AlertModal(app, 't', message),
        () => new ConfirmModal(app, 't', message, () => {}),
    ])('keeps the default message rendering as flat text without conversion structure', (makeModal) => {
        const modal = makeModal();
        modal.open();
        const contentEl = unsafeCast<ReturnType<typeof fakeEl>>(modal.contentEl);
        const messageEl = contentEl.children.find(child => child.cls.includes('youtnote-plugin__base-modal-message'));
        expect(messageEl).toBeDefined();
        expect(messageEl!.text).toBe(message);
        expect(messageEl!.children).toHaveLength(0);
        expect(messageEl!.cls).not.toContain('youtnote-plugin__conversion-message');
    });

    it('removes the abort listener once the decision settles', async () => {
        const openSpy = vi.spyOn(LegacyFormatConversionModal.prototype, 'open')
            .mockImplementation(function (this: LegacyFormatConversionModal) {
                unsafeCast<{ isOpen: boolean; onOpen(): void }>(this).isOpen = true;
                this.onOpen();
            });
        try {
            const controller = new AbortController();
            const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
            const decision = promptLegacyConversionDecision(app, 'file.md', controller.signal);
            const modal = unsafeCast<LegacyFormatConversionModal>(openSpy.mock.contexts[0]);
            expect(removeSpy).not.toHaveBeenCalled();
            modal.close();
            await decision;
            expect(removeSpy).toHaveBeenCalledTimes(1);
            expect(removeSpy.mock.calls[0][1]).toBeInstanceOf(Function);
        } finally {
            openSpy.mockRestore();
        }
    });
});
