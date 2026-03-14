import React, { useRef, useEffect } from 'react';
import classNames from 'classnames';
import { MarkdownRenderer, Component, Platform, setIcon, Menu } from 'obsidian';
import { ObsidianEditor } from './ObsidianEditor';
import { formatSecondsToDisplay, isSafeExternalUrl } from '../utils';
import { ConfirmModal } from './MessageBoxes';
import { NoteListItemProps } from '../types';

// Component for markdown rendering
const MarkdownNoteBody: React.FC<{ app: import('obsidian').App; body: string; sourcePath: string; onDoubleClick: () => void; isExpanded: boolean }> = React.memo(({ app, body, sourcePath, onDoubleClick, isExpanded }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const componentRef = useRef<Component | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        
        // Create a new component for lifecycle management
        if (!componentRef.current) {
            componentRef.current = new Component();
        }
        
        // Clear previous content
        containerRef.current.empty();
        
        // Render markdown
        void MarkdownRenderer.render(app, body, containerRef.current, sourcePath, componentRef.current);
        
        return () => {
            componentRef.current?.unload();
            componentRef.current = null;
        };
    }, [app, body, sourcePath]);

    return (
        <div 
            ref={containerRef} 
            className="youtnote-plugin__markdown-note-body" 
            onDoubleClick={onDoubleClick}
            onClick={(e) => {
                // When expanded, stop propagation to prevent note collapse/highlight
                if (isExpanded) {
                    e.stopPropagation();
                }
                
                const target = e.target as HTMLElement;
                if (target.tagName === 'A') {
                    e.preventDefault();
                    e.stopPropagation();
                    const href = target.getAttribute('href');
                    if (href) {
                        if (target.classList.contains('internal-link')) {
                            void app.workspace.openLinkText(href, sourcePath, e.ctrlKey || e.metaKey);
                        } else if (isSafeExternalUrl(href)) {
                            window.open(href, '_blank', 'noopener,noreferrer');
                        }
                    }
                }
            }}
        />
    );
});

MarkdownNoteBody.displayName = 'MarkdownNoteBody';

export const NoteListItem: React.FC<NoteListItemProps> = React.memo(({
    app,
    view,
    note,
    isExpanded,
    isActive,
    isEditing,
    editingTimestampId,
    editTimestampValue,
    timestampError,
    editNoteBody,
    maxDuration,
    newLineTrigger,
    onToggleExpand,
    onSelect,
    onStartEdit,
    onSaveEdit,
    onBodyChange,
    onStartTimestampEdit,
    onSaveTimestampEdit,
    onCancelTimestampEdit,
    onTimestampChange,
    onDelete
}) => {
    const isEditingTimestamp = editingTimestampId === note.id;

    const handleTimestampDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        const formattedValue = formatSecondsToDisplay(note.timestampSec, maxDuration);
        onStartTimestampEdit(note.id, formattedValue);
    };

    const handleBodyDoubleClick = () => {
        onStartEdit(note.id, note.bodyMarkdown);
    };

    const confirmDeleteNote = () => {
        new ConfirmModal(
            app,
            'Delete note?',
            'Do you really want to delete this note?',
            () => onDelete(note.id),
            'Delete',
            'Cancel'
        ).open();
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        confirmDeleteNote();
    };

    const handleEditClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onStartEdit(note.id, note.bodyMarkdown);
    };

    const handleMobileSavePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onSaveEdit();
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        // Disable context menu on mobile while the note is being edited
        if ((isEditingTimestamp) ||(Platform.isMobile && isEditing)) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        
        // Select the note before showing the context menu (without toggling expand/collapse)
        onSelect(note.id, note.timestampSec);
        
        const menu = new Menu();
        
        menu.addItem((item) => {
            item
                .setTitle('Edit note')
                .setIcon('pencil')
                .onClick(() => {
                    onStartEdit(note.id, note.bodyMarkdown);
                });
        });
        
        menu.addItem((item) => {
            item
                .setTitle('Edit timestamp')
                .setIcon('clock')
                .onClick(() => {
                    const formattedValue = formatSecondsToDisplay(note.timestampSec, maxDuration);
                    onStartTimestampEdit(note.id, formattedValue);
                });
        });
        
        menu.addSeparator();
        
        menu.addItem((item) => {
            item
                .setTitle('Delete note')
                .setIcon('trash')
                .onClick(() => {
                    confirmDeleteNote();
                });
            const typedItem = item as unknown as { dom?: HTMLElement; iconEl?: HTMLElement };
            typedItem.dom?.classList.add('mod-warning', 'mod-danger');
            typedItem.iconEl?.classList.add('mod-warning', 'mod-danger');
        });
        
        menu.showAtMouseEvent(e.nativeEvent);
    };

    const chevronIconRef = useRef<HTMLSpanElement>(null);
    const editIconRef = useRef<HTMLButtonElement>(null);
    const deleteIconRef = useRef<HTMLButtonElement>(null);
    const mobileSaveIconRef = useRef<HTMLButtonElement>(null);
    const timestampEditRef = useRef<HTMLDivElement>(null);
    const hasInitializedTimestampEdit = useRef(false);

    useEffect(() => {
        if (chevronIconRef.current) {
            chevronIconRef.current.empty();
            setIcon(chevronIconRef.current, isExpanded ? 'chevron-down' : 'chevron-right');
        }
    }, [isExpanded]);

    useEffect(() => {
        if (editIconRef.current) {
            editIconRef.current.empty();
            setIcon(editIconRef.current, 'pencil');
        }
    }, [isExpanded, isEditing]);

    useEffect(() => {
        if (deleteIconRef.current) {
            deleteIconRef.current.empty();
            setIcon(deleteIconRef.current, 'trash');
        }
    }, [isExpanded, isEditing]);

    useEffect(() => {
        if (mobileSaveIconRef.current) {
            mobileSaveIconRef.current.empty();
            setIcon(mobileSaveIconRef.current, 'check');
        }
    }, [isEditing]);
    
    // Focus and select text when entering timestamp edit mode
    useEffect(() => {
        if (isEditingTimestamp && timestampEditRef.current && !hasInitializedTimestampEdit.current) {
            // Set the initial text content
            timestampEditRef.current.textContent = editTimestampValue;
            timestampEditRef.current.focus();
            // Select all text in contenteditable
            const range = document.createRange();
            range.selectNodeContents(timestampEditRef.current);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            hasInitializedTimestampEdit.current = true;
        } else if (!isEditingTimestamp) {
            // Reset the flag when exiting edit mode
            hasInitializedTimestampEdit.current = false;
        }
    }, [isEditingTimestamp, editTimestampValue]);

    return (
        <div
            className={classNames('youtnote-plugin__note-card', { 
                expanded: isExpanded, 
                'youtnote-plugin__active-note': isActive,
            })}
            onClick={(e) => onToggleExpand(e, note.id, note.timestampSec)}
            onContextMenu={handleContextMenu}
        >
            <div className="youtnote-plugin__note-header">
                <span className="youtnote-plugin__note-header-icon" ref={chevronIconRef}>
                </span>
                {isEditingTimestamp ? (
                    <div className="youtnote-plugin__timestamp-editor" onClick={(e) => e.stopPropagation()}>
                        <span
                            ref={timestampEditRef}
                            className={classNames('youtnote-plugin__timestamp', 'youtnote-plugin__timestamp-editing', { 'youtnote-plugin__has-error': timestampError })}
                            contentEditable
                            suppressContentEditableWarning
                            onInput={(e) => onTimestampChange(e.currentTarget.textContent || '')}
                            onBlur={() => onSaveTimestampEdit(note.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    onSaveTimestampEdit(note.id);
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    onCancelTimestampEdit();
                                }
                            }}
                        />
                        {timestampError && (
                            <span className="youtnote-plugin__timestamp-error" aria-label={timestampError}>⚠</span>
                        )}
                    </div>
                ) : (
                    <span
                        className="youtnote-plugin__timestamp"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={handleTimestampDoubleClick}
                        aria-label="Double click to edit"
                    >
                        {formatSecondsToDisplay(note.timestampSec, maxDuration)}
                    </span>
                )}
            </div>

            {isEditing ? (
                <div className="youtnote-plugin__note-editor-container" onClick={(e) => e.stopPropagation()}>
                    <ObsidianEditor
                        app={app}
                        view={view}
                        value={editNoteBody}
                        onChange={onBodyChange}
                        onSave={onSaveEdit}
                        onBlur={onSaveEdit}
                        newLineTrigger={newLineTrigger}
                    />
                    {Platform.isMobile && (
                        <button
                            ref={mobileSaveIconRef}
                            className="youtnote-plugin__mobile-note-save-btn"
                            onPointerUp={handleMobileSavePointerUp}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            }}
                            aria-label="Save note"
                        />
                    )}
                </div>
            ) : (
                <MarkdownNoteBody 
                    app={app}
                    body={note.bodyMarkdown}
                    sourcePath=""
                    onDoubleClick={handleBodyDoubleClick}
                    isExpanded={isExpanded}
                />
            )}

            {isExpanded && (
                <div className="youtnote-plugin__note-actions">
                    <button 
                        ref={editIconRef} 
                        onClick={handleEditClick} 
                        aria-label="Edit note"
                        disabled={isEditing}
                    >
                    </button>
                    <button 
                        ref={deleteIconRef} 
                        onClick={handleDelete} 
                        aria-label="Delete note"
                        disabled={isEditing}
                    >
                    </button>
                </div>
            )}
        </div>
    );
});

NoteListItem.displayName = 'NoteListItem';
