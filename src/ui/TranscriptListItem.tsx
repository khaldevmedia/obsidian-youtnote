import React, { useRef, useEffect, useState } from 'react';
import classNames from 'classnames';
import { setIcon, Menu, Platform } from 'obsidian';
import { TranscriptListItemProps } from '../types';

export const TranscriptListItem: React.FC<TranscriptListItemProps> = React.memo(({
    entry,
    index,
    displayTimestamp,
    isActive,
    isEditing,
    onSeek,
    onCopy,
    onCreateNote,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
}) => {
    const textEditRef = useRef<HTMLSpanElement>(null);
    const hasInitializedEdit = useRef(false);
    const skipNextSaveOnBlurRef = useRef(false);
    const [isHovered, setIsHovered] = useState(false);

    // Set initial text and place the caret at the end when entering edit mode
    useEffect(() => {
        if (isEditing && textEditRef.current && !hasInitializedEdit.current) {
            textEditRef.current.textContent = entry.text;
            textEditRef.current.focus();
            const range = activeDocument.createRange();
            range.selectNodeContents(textEditRef.current);
            range.collapse(false);
            const selection = activeWindow.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            hasInitializedEdit.current = true;
        } else if (!isEditing) {
            hasInitializedEdit.current = false;
            skipNextSaveOnBlurRef.current = false;
        }
    }, [isEditing, entry.text]);

    const handleContextMenu = (e: React.MouseEvent) => {
        if (isEditing) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const menu = new Menu();

        menu.addItem((item) => {
            item
                .setTitle('Copy caption')
                .setIcon('copy')
                .onClick(() => {
                    onCopy(entry, displayTimestamp);
                });
        });

        menu.addItem((item) => {
            item
                .setTitle('Create note from this caption')
                .setIcon('square-plus')
                .onClick(() => {
                    onCreateNote(entry, displayTimestamp);
                });
        });

        menu.addItem((item) => {
            item
                .setTitle('Edit caption text')
                .setIcon('pencil')
                .onClick(() => {
                    onStartEdit(index);
                });
        });

        menu.showAtMouseEvent(e.nativeEvent);
    };

    return (
        <div
            className={classNames('youtnote-plugin__transcript-card', { 'youtnote-plugin__active': isActive })}
            data-caption-index={index}
            onContextMenu={handleContextMenu}
            {...(Platform.isMobile ? {} : {
                onMouseEnter: () => setIsHovered(true),
                onMouseLeave: () => setIsHovered(false),
            })}
        >
            <span
                className="youtnote-plugin__transcript-timestamp"
                onClick={(e) => {
                    e.stopPropagation();
                    onSeek(index, entry.startMs);
                }}
                aria-label="Jump to timestamp"
            >
                {displayTimestamp}
            </span>
            {isEditing ? (
                <>
                <span
                    key="editing"
                    ref={textEditRef}
                    className="youtnote-plugin__transcript-text youtnote-plugin__transcript-text-editing"
                    contentEditable
                    suppressContentEditableWarning
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => {
                        if (skipNextSaveOnBlurRef.current) {
                            skipNextSaveOnBlurRef.current = false;
                            return;
                        }
                        onSaveEdit(index, textEditRef.current?.textContent ?? '');
                    }}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.blur();
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            skipNextSaveOnBlurRef.current = true;
                            e.currentTarget.blur();
                            onCancelEdit();
                        }
                    }}
                />
                {Platform.isMobile && (
                    <button
                        ref={(el) => { if (el) { el.empty(); setIcon(el, 'check'); } }}
                        className="youtnote-plugin__transcript-mobile-save-btn"
                        onPointerDown={(e) => { e.preventDefault(); }}
                        onPointerUp={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            skipNextSaveOnBlurRef.current = true;
                            onSaveEdit(index, textEditRef.current?.textContent ?? '');
                        }}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        aria-label="Save caption"
                    />
                )}
                </>
            ) : (
                <span
                    key="display"
                    className="youtnote-plugin__transcript-text"
                    onDoubleClick={() => onStartEdit(index)}
                >
                    {entry.text}
                </span>
            )}
            {isHovered && !isEditing && !Platform.isMobile && (
                <div className="youtnote-plugin__transcript-actions">
                    <button
                        ref={(el) => {
                            if (el) {
                                el.empty();
                                setIcon(el, 'copy');
                            }
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onCopy(entry, displayTimestamp);
                        }}
                        aria-label="Copy caption"
                    />
                    <button
                        ref={(el) => {
                            if (el) {
                                el.empty();
                                setIcon(el, 'square-plus');
                            }
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onCreateNote(entry, displayTimestamp);
                        }}
                        aria-label="Create note from this caption"
                    />
                    <button
                        ref={(el) => {
                            if (el) {
                                el.empty();
                                setIcon(el, 'pencil');
                            }
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            onStartEdit(index);
                        }}
                        aria-label="Edit caption text"
                    />
                </div>
            )}
        </div>
    );
});

TranscriptListItem.displayName = 'TranscriptListItem';
