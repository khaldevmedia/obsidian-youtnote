import React, { useEffect, useRef } from 'react';
import { Platform } from 'obsidian';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { ObsidianEditorProps } from '../types';
import { getMarkdownEditorClass } from '../markdownEditor';

const noop = () => {};
let cachedPrec: any = null;
let cachedEditorView: any = null;
let cachedKeymap: any = null;

/**
 * Creates a controller object that Obsidian's MarkdownEditor expects as its "owner".
 */
function getMarkdownController(view: any, getEditor: () => any): Record<string, any> {
    return {
        app: view.app,
        showSearch: noop,
        toggleMode: noop,
        onMarkdownScroll: noop,
        getMode: () => 'source',
        scroll: 0,
        editMode: null,
        get editor() {
            return getEditor();
        },
        get file() {
            return view.file;
        },
        get path() {
            return view.file?.path ?? '';
        },
    };
}

export const ObsidianEditor: React.FC<ObsidianEditorProps> = ({ app, view, value, onChange, onSave, onBlur, newLineTrigger }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorInstanceRef = useRef<any>(null);
    const isSavingRef = useRef(false);
    const onSaveRef = useRef(onSave);
    const onChangeRef = useRef(onChange);
    const newLineTriggerRef = useRef(newLineTrigger);
    
    // Keep refs up to date
    useEffect(() => {
        onSaveRef.current = onSave;
        onChangeRef.current = onChange;
        newLineTriggerRef.current = newLineTrigger;
    }, [onSave, onChange, newLineTrigger]);

    useEffect(() => {
        if (!containerRef.current) return;
        const container = containerRef.current;
        const plugin = view.plugin;
        if (!plugin.MarkdownEditor) {
            plugin.MarkdownEditor = getMarkdownEditorClass(app);
        }
        const MarkdownEditorClass = plugin.MarkdownEditor;

        if (!MarkdownEditorClass) {
            console.error('[Youtnote] MarkdownEditor class not available');
            return;
        }

        class YoutnoteEditor extends MarkdownEditorClass {
            updateBottomPadding() {}

            onUpdate(update: any, changed: boolean) {
                super.onUpdate(update, changed);
                if (changed) {
                    const text = this.get();
                    onChangeRef.current(text);
                }
            }

            buildLocalExtensions(): any[] {
                const extensions = super.buildLocalExtensions();
                if (!cachedPrec || !cachedEditorView || !cachedKeymap) {
                    cachedPrec = Prec;
                    cachedEditorView = EditorView;
                    cachedKeymap = keymap;
                }

                extensions.push(
                    cachedPrec.highest(
                        cachedEditorView.domEventHandlers({
                            focus: () => {
                                view.activeEditor = controller;
                                setTimeout(() => {
                                    (app.workspace as any).activeEditor = controller;
                                    if (Platform.isMobile) {
                                        (app as any).mobileToolbar?.update();
                                    }
                                });
                                return true;
                            },
                            blur: () => {
                                if (Platform.isMobile) {
                                    (app as any).mobileToolbar?.update();
                                }
                                return true;
                            },
                        })
                    )
                );

                // On mobile, Enter always inserts a newline (no Shift key available).
                // Save is done via an explicit button instead.
                if (!Platform.isMobile) {
                    const makeEnterHandler = (mod: boolean, shift: boolean) => () => {
                        const trigger = newLineTriggerRef.current;
                        const shouldSave = trigger === 'enter'
                            ? (shift || mod)
                            : !(shift || mod);

                        if (shouldSave) {
                            isSavingRef.current = true;
                            onSaveRef.current();
                            return true;
                        }
                        return false;
                    };

                    extensions.push(
                        cachedPrec.highest(
                            cachedKeymap.of([
                                {
                                    key: 'Enter',
                                    run: makeEnterHandler(false, false),
                                    shift: makeEnterHandler(false, true),
                                },
                                {
                                    key: 'Mod-Enter',
                                    run: makeEnterHandler(true, false),
                                    shift: makeEnterHandler(true, true),
                                },
                            ])
                        )
                    );
                }

                return extensions;
            }
        }

        const controller = getMarkdownController(view, () => editor.editor);
        const editor = plugin.addChild(new (YoutnoteEditor as any)(app, container, controller));
        controller.editMode = editor;

        editorInstanceRef.current = editor;
        editor.set(value || '');

        // Focus the editor
        setTimeout(() => {
            editor.editor?.focus();
            // Scroll editor into view after a short delay to let layout settle
            if (Platform.isMobile) {
                setTimeout(() => {
                    container.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }, 100);
            }
        }, 50);

        // On mobile, scroll into view when keyboard appears
        const onKeyboardShow = () => {
            container.scrollIntoView({ block: 'center', behavior: 'smooth' });
        };

        if (Platform.isMobile) {
            window.addEventListener('keyboardDidShow', onKeyboardShow);
        }

        return () => {
            if (Platform.isMobile) {
                window.removeEventListener('keyboardDidShow', onKeyboardShow);

                if (view.activeEditor === controller) {
                    view.activeEditor = null;
                }

                if ((app.workspace as any).activeEditor === controller) {
                    (app.workspace as any).activeEditor = null;
                    (app as any).mobileToolbar?.update();
                }
            }
            plugin.removeChild(editor);
            editorInstanceRef.current = null;
        };
    }, [app, view]);

    return (
        <div 
            ref={containerRef} 
            className="youtnote-plugin__obsidian-editor-container"
            onBlur={(e) => {
                // On mobile, don't end editing on blur — the user needs to
                // interact with Obsidian's toolbar (bold, italic, etc.) which
                // steals focus. A dedicated save button is used instead.
                if (Platform.isMobile) return;
                // Only trigger onBlur if we're not currently saving
                // and if the blur is going outside the editor container
                if (!isSavingRef.current && onBlur && !e.currentTarget.contains(e.relatedTarget as Node)) {
                    onBlur();
                }
                isSavingRef.current = false;
            }}
            tabIndex={-1}
        />
    );
};
