import { App } from 'obsidian';

let cachedMarkdownEditor: any = null;

export function getMarkdownEditorClass(app: App) {
    if (cachedMarkdownEditor) return cachedMarkdownEditor;

    const embedByExtension = (app as any)?.embedRegistry?.embedByExtension;
    if (!embedByExtension?.md) {
        console.error('[Youtnote] embedRegistry.embedByExtension.md is not available');
        return null;
    }
    
    // Create a dummy container
    const container = document.createElement('div');
    container.style.display = 'none';
    document.body.appendChild(container);
    
    try {
        // Instantiate the embed
        const md = (app as any).embedRegistry.embedByExtension.md(
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
            // Extract the raw constructor
            const proto = Object.getPrototypeOf(md.editMode);
            const parentProto = proto ? Object.getPrototypeOf(proto) : null;
            cachedMarkdownEditor = parentProto?.constructor || md.editMode.constructor || null;
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
