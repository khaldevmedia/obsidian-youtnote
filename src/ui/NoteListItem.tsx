import React, { useRef, useEffect } from 'react';
import classNames from 'classnames';
import { MarkdownRenderer, Component, Platform, setIcon, Menu } from 'obsidian';
import { ObsidianEditor } from './ObsidianEditor';
import { formatSecondsToDisplay, isSafeExternalUrl } from '../utils';
import { ConfirmModal } from './MessageBoxes';
import { NoteListItemProps } from '../types';

// Component for markdown rendering
const MarkdownNoteBody: React.FC<{ app: import('obsidian').App; body: string; sourcePath: string; onDoubleClick: () => void; isExpanded: boolean; readOnly: boolean }> = React.memo(({ app, body, sourcePath, onDoubleClick, isExpanded, readOnly }) => {
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
        void MarkdownRenderer.render(app, body, containerRef.current, sourcePath, componentRef.current)
            .then(() => {
                if (!readOnly || !containerRef.current) return;
                containerRef.current.querySelectorAll('input, textarea').forEach(el => {
                    (el as HTMLInputElement | HTMLTextAreaElement).disabled = true;
                });
            });

        return () => {
            componentRef.current?.unload();
            componentRef.current = null;
        };
    }, [app, body, sourcePath, readOnly]);

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
                const anchor = target.closest('a');
                if (anchor && containerRef.current?.contains(anchor)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const href = anchor.getAttribute('href');
                    if (href) {
                        if (anchor.classList.contains('internal-link')) {
                            void app.workspace.openLinkText(href, sourcePath, e.ctrlKey || e.metaKey);
                        } else if (isSafeExternalUrl(href)) {
                            activeWindow.open(href, '_blank', 'noopener,noreferrer');
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
    isGeneral,
    readOnly,
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
    const isEditingTimestamp = !readOnly && editingTimestampId === note.id;

    const handleTimestampDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (readOnly) return;
        const formattedValue = formatSecondsToDisplay(note.timestampSec, maxDuration);
        onStartTimestampEdit(note.id, formattedValue);
    };

    const handleBodyDoubleClick = () => {
        if (readOnly) return;
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
        if (readOnly || (isEditingTimestamp) ||(Platform.isMobile && isEditing)) {
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
        
        if (!isGeneral) {
            menu.addItem((item) => {
                item
                    .setTitle('Edit timestamp')
                    .setIcon('clock')
                    .onClick(() => {
                        const formattedValue = formatSecondsToDisplay(note.timestampSec, maxDuration);
                        onStartTimestampEdit(note.id, formattedValue);
                    });
            });
        }
        
        menu.addSeparator();
        
        menu.addItem((item) => {
            item
                .setTitle('Delete note')
                .setIcon('trash')
                .setWarning(true)
                .onClick(() => {
                    confirmDeleteNote();
                });
        });
        
        menu.showAtMouseEvent(e.nativeEvent);
    };

    const chevronIconRef = useRef<HTMLSpanElement>(null);
    const editIconRef = useRef<HTMLButtonElement>(null);
    const deleteIconRef = useRef<HTMLButtonElement>(null);
    const mobileSaveIconRef = useRef<HTMLButtonElement>(null);
    const timestampEditRef = useRef<HTMLDivElement>(null);
    const hasInitializedTimestampEdit = useRef(false);
    const skipNextSaveOnBlurRef = useRef(false);

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
            const range =activeDocument.createRange();
            range.selectNodeContents(timestampEditRef.current);
            const selection = activeWindow.getSelection();
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
                'youtnote-plugin__general-note': isGeneral,
            })}
            onClick={(e) => onToggleExpand(e, note.id, note.timestampSec)}
            onContextMenu={handleContextMenu}
        >
            <div className="youtnote-plugin__note-header">
                <span className="youtnote-plugin__note-header-icon" ref={chevronIconRef}>
                </span>
                {isGeneral ? (
                    <span className="youtnote-plugin__general-note-label">
                        <span className="youtnote-plugin__general-note-text">General note</span>
                    </span>
                ) : isEditingTimestamp ? (
                    <div className="youtnote-plugin__timestamp-editor" onClick={(e) => e.stopPropagation()}>
                        <span
                            ref={timestampEditRef}
                            className={classNames('youtnote-plugin__timestamp', 'youtnote-plugin__timestamp-editing', { 'youtnote-plugin__has-error': timestampError })}
                            contentEditable
                            suppressContentEditableWarning
                            onInput={(e) => onTimestampChange(e.currentTarget.textContent || '')}
                            onBlur={() => {
                                if (skipNextSaveOnBlurRef.current) {
                                    skipNextSaveOnBlurRef.current = false;
                                    return;
                                }
                                onSaveTimestampEdit(note.id);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    e.currentTarget.blur();
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    skipNextSaveOnBlurRef.current = true;
                                    e.currentTarget.blur();
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
                        aria-label={readOnly ? undefined : 'Double click to edit'}
                    >
                        {formatSecondsToDisplay(note.timestampSec, maxDuration)}
                    </span>
                )}
            </div>

            {isEditing && !readOnly ? (
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
                            className="youtnote-plugin__mobile-save-btn youtnote-plugin__mobile-note-save-btn"
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
                    onDoubleClick={readOnly ? () => {} : handleBodyDoubleClick}
                    isExpanded={isExpanded}
                    readOnly={readOnly}
                />
            )}

            {isExpanded && !readOnly && (
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
