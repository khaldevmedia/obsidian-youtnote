import React, { useRef, useEffect } from 'react';
import classNames from 'classnames';
import { setIcon, Menu, Notice } from 'obsidian';
import { ConfirmModal } from './MessageBoxes';
import { VideoListItemProps } from '../types';


export const VideoListItem: React.FC<VideoListItemProps> = React.memo(({
    app,
    video,
    isActive,
    onSelect,
    onDelete
}) => {
    const deleteIconRef = useRef<HTMLButtonElement>(null);
    const copyIconRef = useRef<HTMLButtonElement>(null);
    const handleIconRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (deleteIconRef.current) {
            deleteIconRef.current.empty();
            setIcon(deleteIconRef.current, 'trash');
        }
        if (copyIconRef.current) {
            copyIconRef.current.empty();
            setIcon(copyIconRef.current, 'copy');
        }
        if (handleIconRef.current) {
            handleIconRef.current.empty();
            setIcon(handleIconRef.current, 'grip-vertical');
        }
    }, []);

    const confirmDeleteVideo = () => {
        new ConfirmModal(
            app,
            'Delete video?',
            'Do you really want to delete this video and all its notes?',
            () => onDelete(video.id),
            'Delete',
            'Cancel'
        ).open();
    };

    const copyVideoUrl = async () => {
        try {
            await navigator.clipboard.writeText(video.url);
            new Notice('Video URL was copied to the clipboard!', 2000);
        } catch (err) {
            console.error('Failed to copy URL:', err);
            new Notice('Failed to copy video URL!', 2000);
        }
    };

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        confirmDeleteVideo();
    };

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await copyVideoUrl();
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Select the video before showing the context menu
        onSelect(video.id);
        
        const menu = new Menu();
        
        menu.addItem((item) => {
            item
                .setTitle('Copy URL')
                .setIcon('copy')
                .onClick(() => {
                    void copyVideoUrl();
                });
        });
        
        menu.addSeparator();
        
        menu.addItem((item) => {
            item
                .setTitle('Delete video')
                .setIcon('trash')
                .onClick(() => {
                    confirmDeleteVideo();
                });
            const itemEl = (item as any).dom as HTMLElement | undefined;
            const iconEl = (item as any).iconEl as HTMLElement | undefined;
            itemEl?.classList.add('mod-warning', 'mod-danger');
            iconEl?.classList.add('mod-warning', 'mod-danger');
        });
        
        menu.showAtMouseEvent(e.nativeEvent);
    };

    return (
        <div
            className={classNames('youtnote-plugin__video-item', { "youtnote-plugin__active": isActive })}
            onClick={() => onSelect(video.id)}
            onContextMenu={handleContextMenu}
        >
            <span ref={handleIconRef} className="youtnote-plugin__drag-handle"></span>
            {video.thumbnail && <img src={video.thumbnail} alt={video.title} />}
            <span className="youtnote-plugin__video-title">{video.title || video.url}</span>
            <button
                ref={copyIconRef}
                className="youtnote-plugin__video-copy-btn"
                onClick={handleCopy}
                aria-label="Copy video URL"
            >
            </button>
            <button
                ref={deleteIconRef}
                className="youtnote-plugin__video-delete-btn"
                onClick={handleDelete}
                aria-label="Delete video"
            >
            </button>
        </div>
    );
});

VideoListItem.displayName = 'VideoListItem';
