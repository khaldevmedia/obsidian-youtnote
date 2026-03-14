import { App } from 'obsidian';
import { MarkdownEditorClass } from './types';

let cachedMarkdownEditor: MarkdownEditorClass | null = null;

export function getMarkdownEditorClass(app: App): MarkdownEditorClass | null {
    if (cachedMarkdownEditor) return cachedMarkdownEditor;

    if (!app.embedRegistry?.embedByExtension?.md) {
        console.error('[Youtnote] embedRegistry.embedByExtension.md is not available');
        return null;
    }

    // Create a dummy container
    const container = document.createElement('div');
    container.hide();
    document.body.appendChild(container);

    try {
        // Instantiate the embed
        const md = app.embedRegistry.embedByExtension.md(
            { app, containerEl: container, state: {} },
            null,
            ''
        );

        md.load();

        // Mirror the original working extraction path used in main.ts.
        if ('editable' in md) {
            md.editable = true;
        }
        if (typeof md.showEditor === 'function') {
            md.showEditor();
        }

        if (md.editMode) {
            // Extract the raw constructor from the prototype chain
            const editModeObj: object = md.editMode;
            const proto = Object.getPrototypeOf(editModeObj) as object | null;
            const parentProto = proto != null
                ? Object.getPrototypeOf(proto) as object | null
                : null;
            const ctor: unknown =
                (parentProto as { constructor?: unknown } | null)?.constructor
                ?? (editModeObj as { constructor?: unknown }).constructor;
            if (ctor != null) {
                cachedMarkdownEditor = ctor as MarkdownEditorClass;
            }
        }

        md.unload();
    } catch (err) {
        console.error('[Youtnote] Failed to extract MarkdownEditor class:', err);
    } finally {
        container.remove();
    }

    if (!cachedMarkdownEditor) {
        console.error('[Youtnote] MarkdownEditor class extraction returned null');
    }

    return cachedMarkdownEditor;
}
