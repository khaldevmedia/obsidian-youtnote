import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { AlertModal, ConfirmModal, LegacyFormatConversionModal, promptLegacyConversionDecision } from './MessageBoxes';

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
        createSpan(options?: { text?: string }): FakeEl;
        setText(text: string): void;
        addEventListener(type: string, handler: () => void): void;
        contains(node: unknown): boolean;
        focus(): void;
        click(): void;
        findByAction(action: string): FakeEl | null;
        dataset: Record<string, string>;
    }
    function fakeEl(): FakeEl {
        const el: FakeEl = {
            tag: 'div',
            cls: '',
            text: '',
            children: [],
            dataset: {},
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
                el.children.push(child);
                return child;
            },
            createSpan(options) {
                const child = fakeEl();
                child.text = options?.text ?? '';
                el.children.push(child);
                return child;
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
        await expect(modal.decision).resolves.toBe('convert');
    });

    it.each(['close', 'double-close'] as const)('resolves read-only exactly once on %s dismissal', async (kind) => {
        const modal = new LegacyFormatConversionModal(app, 'a.md');
        const decisions: string[] = [];
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
