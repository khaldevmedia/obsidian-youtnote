import React, { useState, useEffect, useRef, useMemo } from 'react';
import classNames from 'classnames';
import { requestUrl, setIcon, Notice, Platform } from 'obsidian';
import Sortable, { SortableEvent } from 'sortablejs';
import { YouTubeIframeAdapter } from '../PlayerAdapter';
import { VideoId, NoteId, Video, Note } from '../types';
import { VideoListItem } from './VideoListItem';
import { NoteListItem } from './NoteListItem';
import { AlertModal, ConfirmModal } from './MessageBoxes';
import { YoutubePluginViewProps } from '../types';
import {
    extractYouTubeId,
    normalizeYouTubeUrl,
    parseTimestampInput,
    calculateTotalWords,
    calculateTotalCharacters,
    formatSecondsToDisplay
} from '../utils';



export const YoutubePluginView: React.FC<YoutubePluginViewProps> = ({ 
    app,
    view,
    settings, 
    videos, 
    notes, 
    activeVideoId, 
    setActiveVideoId,
    onUpdateVideos,
    onUpdateNotes,
    onExportSingleVideo,
    onExportAllVideos
}) => {
    const activeVideoNotes = useMemo(
        () => notes.filter(n => n.videoId === activeVideoId),
        [notes, activeVideoId]
    );
    const activeVideo = useMemo(
        () => videos.find(v => v.id === activeVideoId),
        [videos, activeVideoId]
    );
    const activeVideoUrl = activeVideo?.url ?? null;
    const activeVideoStats = useMemo(() => {
        const noteBodies = activeVideoNotes.map(n => n.bodyMarkdown);
        return {
            words: calculateTotalWords(noteBodies),
            characters: calculateTotalCharacters(noteBodies),
        };
    }, [activeVideoNotes]);

    const iframeRef = useRef<HTMLIFrameElement>(null);
    const playerAdapterRef = useRef<YouTubeIframeAdapter | null>(null);
    const adapterIframeRef = useRef<HTMLIFrameElement | null>(null);
    const videoListRef = useRef<HTMLDivElement>(null);
    const exportButtonRef = useRef<HTMLButtonElement>(null);
    const exportAllButtonRef = useRef<HTMLButtonElement>(null);
    const mergeNotesButtonRef = useRef<HTMLButtonElement>(null);
    const [isPlayerReady, setIsPlayerReady] = useState(true);
    const playerTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const videoLoadRequestRef = useRef(0);

    // State for new video input
    const [newVideoUrl, setNewVideoUrl] = useState('');
    const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);

    // State for expanded notes
    const [expandedNotes, setExpandedNotes] = useState<Set<NoteId>>(new Set());
    
    // State for active/highlighted note (last note that triggered a seek)
    const [activeNoteId, setActiveNoteId] = useState<NoteId | null>(null);
    
    // State for newly created note (to trigger scroll into view)
    const [newlyCreatedNoteId, setNewlyCreatedNoteId] = useState<NoteId | null>(null);
    
    // State for editing note
    const [editingNoteId, setEditingNoteId] = useState<NoteId | null>(null);
    const [editNoteBody, setEditNoteBody] = useState('');
    
    // State for editing timestamp
    const [editingTimestampId, setEditingTimestampId] = useState<NoteId | null>(null);
    const [editTimestampValue, setEditTimestampValue] = useState('');
    const [timestampError, setTimestampError] = useState<string | null>(null);

    // State for resizable panes
    const containerRef = useRef<HTMLDivElement>(null);
    const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() => {
        const saved = localStorage.getItem('youtnote-plugin__notes-left-pane-width');
        return saved ? parseFloat(saved) : 50;
    });
    const leftPaneWidthRef = useRef(leftPaneWidth);
    const [isResizing, setIsResizing] = useState(false);

    // Minimum widths in percentage
    const MIN_LEFT_WIDTH = 25;
    const MIN_RIGHT_WIDTH = 25;

    // Video player timeout message
    const TIMEOUT_TITLE = 'YouTube video player failed to load'
    const TIMEOUT_MESSAGE = 'The video player failed to load properly. Troubleshooting: Check your internet connection, close the tab and reopen it or restart Obsidian.'

    const isMobile = Platform.isMobile;
    const isStickyEnabled = isMobile && settings.pinOnPhone;
    
    // Video embedding blocked message
    const EMBEDDING_BLOCKED_TITLE = 'Video cannot be played in Obsidian'
    const EMBEDDING_BLOCKED_MESSAGE = 'This video has embedding disabled by its creator and cannot be played within Obsidian. You can still add notes with manually added timestamps, but you\'ll need to watch the video on YouTube directly.'

    // Reset expanded notes when video changes if not persisting
    useEffect(() => {
        if (!settings.persistExpandedState) {
            setExpandedNotes(new Set());
        }
    }, [activeVideoId, settings.persistExpandedState]);
    
    // Handle singleExpandMode changes - collapse extra notes when switching to single mode
    useEffect(() => {
        if (settings.singleExpandMode && expandedNotes.size > 1) {
            setExpandedNotes(prev => {
                const next = new Set<NoteId>();
                // Keep only the active note expanded, or the first expanded note if no active note
                if (activeNoteId && prev.has(activeNoteId)) {
                    next.add(activeNoteId);
                } else {
                    const firstExpanded = Array.from(prev)[0];
                    if (firstExpanded) {
                        next.add(firstExpanded);
                    }
                }
                return next;
            });
        }
    }, [settings.singleExpandMode, activeNoteId]);

    // Use a ref for videos so we can access the latest state in the async onReady callback without adding it to dependencies
    const videosRef = useRef(videos);
    useEffect(() => {
        videosRef.current = videos;
    }, [videos]);

    useEffect(() => {
        leftPaneWidthRef.current = leftPaneWidth;
    }, [leftPaneWidth]);

    useEffect(() => {
        if (exportButtonRef.current) {
            setIcon(exportButtonRef.current, 'file-down');
        }
        if (exportAllButtonRef.current) {
            setIcon(exportAllButtonRef.current, 'file-down');
        }
        if (mergeNotesButtonRef.current) {
            setIcon(mergeNotesButtonRef.current, 'list-plus');
        }
    }, [activeVideoId, activeVideoNotes.length, videos.length, notes.length]);

    useEffect(() => {
        if (videoListRef.current) {
            const sortable = Sortable.create(videoListRef.current, {
                handle: '.youtnote-plugin__drag-handle',
                animation: 150,
                forceFallback: true,
                fallbackOnBody: true,
                onEnd: (evt: SortableEvent) => {
                    const oldIndex = evt.oldIndex!;
                    const newIndex = evt.newIndex!;
                    if (oldIndex !== newIndex) {
                        const newVideos = [...videosRef.current];
                        const [moved] = newVideos.splice(oldIndex, 1);
                        newVideos.splice(newIndex, 0, moved);
                        onUpdateVideos(newVideos);
                    }
                }
            });
            return () => {
                sortable.destroy();
            };
        }
    }, [onUpdateVideos]);

    useEffect(() => {
        const requestId = ++videoLoadRequestRef.current;
        const isLatestRequest = () => videoLoadRequestRef.current === requestId;

        const clearPlayerTimeout = () => {
            if (playerTimeoutRef.current) {
                clearTimeout(playerTimeoutRef.current);
                playerTimeoutRef.current = null;
            }
        };

        const startPlayerLoadTimeout = () => {
            clearPlayerTimeout();
            playerTimeoutRef.current = setTimeout(() => {
                if (!isLatestRequest()) return;
                new AlertModal(app, TIMEOUT_TITLE, TIMEOUT_MESSAGE).open();
                setIsPlayerReady(true);
                playerTimeoutRef.current = null;
            }, 10000);
        };

        const currentIframe = iframeRef.current;
        const currentActiveVideo = videosRef.current.find(v => v.id === activeVideoId);

        if (!currentActiveVideo || !currentIframe) {
            setIsPlayerReady(true);
            if (!currentActiveVideo && playerAdapterRef.current) {
                // Keep adapter alive – YT.Player.destroy() removes the iframe
                // from the DOM which breaks React's ref and all future player
                // creation.  The API is designed to reuse players via
                // cueVideoById, so just pause and leave the adapter intact.
                void playerAdapterRef.current.pause();
            }
            return () => {
                clearPlayerTimeout();
            };
        }

        if (adapterIframeRef.current !== currentIframe && playerAdapterRef.current) {
            playerAdapterRef.current.destroy();
            playerAdapterRef.current = null;
        }
        adapterIframeRef.current = currentIframe;

        const ytId = extractYouTubeId(currentActiveVideo.url);
        if (!ytId) {
            setIsPlayerReady(true);
            return () => {
                clearPlayerTimeout();
            };
        }

        const existingAdapter = playerAdapterRef.current;

        const handleDurationUpdate = async (adapter: YouTubeIframeAdapter, videoId: VideoId) => {
            try {
                const duration = await adapter.getDuration();
                const latestVideo = videosRef.current.find(v => v.id === videoId);
                if (latestVideo && duration > 0 && duration !== latestVideo.durationSec) {
                    const updatedVideos = videosRef.current.map(v =>
                        v.id === videoId ? { ...v, durationSec: duration } : v
                    );
                    onUpdateVideos(updatedVideos);
                }
            } catch (e) {
                console.warn('Could not fetch video duration', e);
            }
        };

        if (existingAdapter && existingAdapter.isReady()) {
            console.log('[YoutnoteView] Loading new video in existing player');

            startPlayerLoadTimeout();
            existingAdapter.loadVideo(ytId).then(async () => {
                if (!isLatestRequest()) return;
                clearPlayerTimeout();
                await handleDurationUpdate(existingAdapter, currentActiveVideo.id);
                if (isLatestRequest()) {
                    setIsPlayerReady(true);
                }
            }).catch((errorCode: unknown) => {
                if (!isLatestRequest()) return;
                const numericErrorCode = typeof errorCode === 'number' ? errorCode : Number(errorCode);
                if (numericErrorCode === 101 || numericErrorCode === 150) {
                    clearPlayerTimeout();
                    new AlertModal(app, EMBEDDING_BLOCKED_TITLE, EMBEDDING_BLOCKED_MESSAGE).open();
                    setIsPlayerReady(true);
                    return;
                }
                console.warn('[YoutnoteView] Failed to load video in existing player', errorCode);
                clearPlayerTimeout();
                setIsPlayerReady(true);
            });
        } else {
            if (existingAdapter) {
                console.log('[YoutnoteView] Existing adapter not ready, destroying before re-creating');
                existingAdapter.destroy();
                playerAdapterRef.current = null;
            }
            console.log('[YoutnoteView] Creating new player adapter');
            setIsPlayerReady(false);

            const adapter = new YouTubeIframeAdapter(currentIframe, ytId, async () => {
                if (!isLatestRequest()) return;
                await handleDurationUpdate(adapter, currentActiveVideo.id);
                clearPlayerTimeout();
                if (isLatestRequest()) {
                    setIsPlayerReady(true);
                }
            }, (errorCode: number) => {
                if (errorCode === 101 || errorCode === 150) {
                    clearPlayerTimeout();
                    new AlertModal(app, EMBEDDING_BLOCKED_TITLE, EMBEDDING_BLOCKED_MESSAGE).open();
                    setIsPlayerReady(true);
                }
            });

            playerAdapterRef.current = adapter;
            adapterIframeRef.current = currentIframe;
            startPlayerLoadTimeout();
        }

        return () => {
            clearPlayerTimeout();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeVideoId, activeVideoUrl]);

    useEffect(() => {
        return () => {
            if (playerAdapterRef.current) {
                playerAdapterRef.current.destroy();
                playerAdapterRef.current = null;
                adapterIframeRef.current = null;
            }
            if (playerTimeoutRef.current) {
                clearTimeout(playerTimeoutRef.current);
                playerTimeoutRef.current = null;
            }
        };
    }, []);

    const seekToTimestamp = async (timestampSec: number) => {
        const playerAdapter = playerAdapterRef.current;
        if (!playerAdapter) return;

        if (settings.autoplayOnNoteSelect) {
            await playerAdapter.seek(timestampSec);
            await playerAdapter.play();
        } else {
            await playerAdapter.seekAndPause(timestampSec);
        }
    };

    const handleNoteClick = async (e: React.MouseEvent, noteId: NoteId, timestampSec: number) => {
        // Prevent clicking if we're clicking an action button inside the note
        if ((e.target as HTMLElement).closest('.youtnote-plugin__note-actions') || (e.target as HTMLElement).closest('.youtnote-plugin__timestamp-editor')) return;

        // Toggle expand state
        setExpandedNotes(prev => {
            const next = new Set(prev);
            if (next.has(noteId)) {
                next.delete(noteId);
            } else {
                if (settings.singleExpandMode) {
                    next.clear();
                }
                next.add(noteId);
            }
            return next;
        });
        
        // Set as active note (for highlighting)
        setActiveNoteId(noteId);

        // Handle video playback - PlayerAdapter.seek() has internal waiting logic
        await seekToTimestamp(timestampSec);
    };

    const handleNoteSelect = async (noteId: NoteId, timestampSec: number) => {
        // Select note without toggling expand/collapse (used for right-click)
        setActiveNoteId(noteId);

        // Handle video playback - PlayerAdapter.seek() has internal waiting logic
        await seekToTimestamp(timestampSec);
    };

    const handleAddNote = async () => {
        if (!activeVideoId) return;
        
        let currentTime = 0;
        const playerAdapter = playerAdapterRef.current;
        if (playerAdapter && playerAdapter.isReady()) {
            try {
                currentTime = await playerAdapter.getCurrentTime() || 0;
            } catch (e) {
                console.warn("Could not get current time from player adapter", e);
            }
        }

        const normalizedTimestamp = Math.floor(currentTime);
        const newNoteId = crypto.randomUUID() as NoteId;
        const newNote: Note = {
            id: newNoteId,
            videoId: activeVideoId,
            timestampSec: normalizedTimestamp,
            bodyMarkdown: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const newNotes = [...notes, newNote].sort((a, b) => a.timestampSec - b.timestampSec);
        onUpdateNotes(newNotes);
        
        // Mark as newly created for scroll into view
        setNewlyCreatedNoteId(newNoteId);
        
        // Clear any previously selected note
        setActiveNoteId(null);
        
        // Auto-expand the new note
        setExpandedNotes(prev => {
            const next = new Set(prev);
            if (settings.singleExpandMode) next.clear();
            next.add(newNoteId);
            return next;
        });
        setEditingNoteId(newNoteId);
        setEditNoteBody('');
    };

    const handleAddVideoSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newVideoUrl || isFetchingMetadata) return;

        const ytId = extractYouTubeId(newVideoUrl);
        if (!ytId) {
            new AlertModal(app, "Invalid URL", "The URL you provided is not a valid YouTube URL.").open();
            return;
        }

        // Normalize URL to consistent format (strips playlist params, converts shorts/youtu.be)
        const normalizedUrl = normalizeYouTubeUrl(newVideoUrl);
        if (!normalizedUrl) {
            new AlertModal(app, "Invalid URL", "The URL you provided is not a valid YouTube URL.").open();
            return;
        }

        // Check if a video with the same YouTube ID already exists
        const existingVideo = videos.find(v => extractYouTubeId(v.url) === ytId);
        if (existingVideo) {
            new AlertModal(app, "Video duplication", "This video already exists in your list.").open();
            // Select the existing video after alert is dismissed
            setTimeout(() => {
                setActiveVideoId(existingVideo.id);
                // Scroll to the existing video
                if (videoListRef.current) {
                    const videoElements = videoListRef.current.querySelectorAll('.youtnote-plugin__video-item');
                    const existingIndex = videos.findIndex(v => v.id === existingVideo.id);
                    if (existingIndex !== -1 && videoElements[existingIndex]) {
                        videoElements[existingIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }
            }, 100);
            setNewVideoUrl('');
            return;
        }

        setIsFetchingMetadata(true);
        try {
            // Fetch metadata using YouTube's oEmbed endpoint (no API key required)
            // This also validates that the video exists
            const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`;
            const response = await requestUrl({ url: oembedUrl });
            
            if (response.status !== 200) {
                throw new Error("Video not found or unavailable");
            }

            const data = response.json;
            
            const ytId = extractYouTubeId(normalizedUrl);
            const newVideo: Video = {
                id: crypto.randomUUID() as VideoId,
                url: normalizedUrl,
                title: data.title || `YouTube Video (${ytId})`,
                thumbnail: data.thumbnail_url || `https://img.youtube.com/vi/${ytId}/default.jpg`,
                durationSec: 0 // oEmbed doesn't provide duration, we'd need YouTube Data API for that
            };
            onUpdateVideos([...videos, newVideo]);
            setNewVideoUrl('');
            
            // Set the newly added video as active
            setActiveVideoId(newVideo.id);
            
            // Auto-scroll to the newly added video
            setTimeout(() => {
                if (videoListRef.current) {
                    videoListRef.current.scrollTop = videoListRef.current.scrollHeight;
                }
            }, 100);
        } catch (error) {
            console.error("Error fetching YouTube metadata:", error);
            new AlertModal(app, "Unable to add video", "The video may not exist, be private, be unavailable or be with invalid ID.").open();
        } finally {
            setIsFetchingMetadata(false);
        }
    };

    const saveNoteEdit = () => {
        if (editingNoteId) {
            const newNotes = notes.map(n => n.id === editingNoteId ? { ...n, bodyMarkdown: editNoteBody, updatedAt: new Date().toISOString() } : n)
                .sort((a, b) => a.timestampSec - b.timestampSec);
            onUpdateNotes(newNotes);
            setActiveNoteId(editingNoteId);
            setEditingNoteId(null);
        }
    };

    const handleTimestampChange = (value: string) => {
        setEditTimestampValue(value);
        
        // Validate in real-time if there's actual input
        if (value.trim()) {
            const maxDuration = activeVideo?.durationSec || 0;
            const result = parseTimestampInput(value, maxDuration);
            
            // Show error immediately if validation fails
            if (result.error) {
                setTimestampError(result.error);
            } else {
                setTimestampError(null);
            }
        } else {
            setTimestampError(null);
        }
    };

    const saveTimestampEdit = async (noteId: NoteId) => {
        if (!editTimestampValue.trim()) {
            setEditingTimestampId(null);
            setTimestampError(null);
            return;
        }

        // Get max duration from active video, default to 0 if not available
        const maxDuration = activeVideo?.durationSec || 0;
        
        // Parse with validation
        const result = parseTimestampInput(editTimestampValue, maxDuration);
        
        // If there's an error, show it and prevent saving until the user fixes it or cancels
        if (result.error) {
            setTimestampError(result.error);
            return;
        }
        
        const newNotes = notes.map(n => n.id === noteId ? { ...n, timestampSec: result.seconds, updatedAt: new Date().toISOString() } : n)
            .sort((a, b) => a.timestampSec - b.timestampSec);
        
        onUpdateNotes(newNotes);
        setEditingTimestampId(null);
        setTimestampError(null);
        
        // Ensure the edited note remains selected after reordering
        setExpandedNotes(prev => {
            const next = new Set(prev);
            if (settings.singleExpandMode) {
                next.clear();
            }
            next.add(noteId);
            return next;
        });
        
        // Set as active note (for highlighting)
        setActiveNoteId(noteId);

        // Seek to the new timestamp in the player
        const playerAdapter = playerAdapterRef.current;
        if (playerAdapter) {
            await playerAdapter.seek(result.seconds);
            
            if (settings.autoplayOnNoteSelect) {
                await playerAdapter.play();
            } else {
                // Always pause after seek to prevent autoplay
                await playerAdapter.pause();
            }
        }
    };

    const cancelTimestampEdit = () => {
        setEditingTimestampId(null);
        setTimestampError(null);
    };

    const deleteNote = (noteId: NoteId) => {
        onUpdateNotes(notes.filter(n => n.id !== noteId));
    };

    const deleteVideo = (videoId: VideoId) => {
        const remainingVideos = videos.filter(v => v.id !== videoId);
        onUpdateVideos(remainingVideos);
        if (activeVideoId === videoId) {
            setActiveVideoId(remainingVideos.length > 0 ? remainingVideos[0].id : null);
        }
    };

    const handleMergeDuplicateNotes = () => {
        if (!activeVideoId) return;

        const notesByTimestamp = new Map<number, Note[]>();
        activeVideoNotes.forEach(note => {
            const existing = notesByTimestamp.get(note.timestampSec) || [];
            existing.push(note);
            notesByTimestamp.set(note.timestampSec, existing);
        });

        const duplicateGroups: { primary: Note; duplicates: Note[] }[] = [];

        notesByTimestamp.forEach(group => {
            if (group.length <= 1) return;
            const [first, ...rest] = group;
            duplicateGroups.push({ primary: first, duplicates: rest });
        });

        if (!duplicateGroups.length) {
            new AlertModal(
                app,
                'No duplicates',
                'No notes with duplicate timestamps found!'
            ).open();
            return;
        }

        const formattedTimestamps = duplicateGroups
            .map(group => formatSecondsToDisplay(group.primary.timestampSec, activeVideo?.durationSec || 0));
        const timestampSummary = formattedTimestamps.length
            ? `: ${formattedTimestamps.map(ts => `(${ts})`).join(', ')}`
            : '';

        new ConfirmModal(
            app,
            'Merge duplicates?',
            `Found ${duplicateGroups.length} group(s) of notes with duplicate timestamps${timestampSummary}. Do you really want to merge them?`,
            () => {
                const now = new Date().toISOString();
                const notesToDelete = new Set<NoteId>();
                const mergedBodies = new Map<NoteId, string>();
                const mergedTargetIds = duplicateGroups.map(group => group.primary.id);

                duplicateGroups.forEach(({ primary, duplicates }) => {
                    const mergedBody = [primary, ...duplicates]
                        .map(n => n.bodyMarkdown)
                        .join('\n\n');
                    mergedBodies.set(primary.id, mergedBody);
                    duplicates.forEach(n => notesToDelete.add(n.id));
                });

                const newNotes = notes
                    .map(note => {
                        if (mergedBodies.has(note.id)) {
                            return { ...note, bodyMarkdown: mergedBodies.get(note.id) || note.bodyMarkdown, updatedAt: now };
                        }
                        return note;
                    })
                    .filter(note => !notesToDelete.has(note.id))
                    .sort((a, b) => a.timestampSec - b.timestampSec);

                onUpdateNotes(newNotes);

                if (mergedTargetIds.length) {
                    const [primaryTarget] = mergedTargetIds;
                    setActiveNoteId(primaryTarget);
                    setExpandedNotes(prev => {
                        if (settings.singleExpandMode) {
                            const next = new Set<NoteId>();
                            next.add(primaryTarget);
                            return next;
                        }
                        const next = new Set(prev);
                        mergedTargetIds.forEach(id => next.add(id));
                        return next;
                    });
                }
                new Notice(`Merged ${mergedTargetIds.length} group(s) of duplicates`, 2000);
            },
            'Merge',
            'Cancel'
        ).open();
    };

    // Resize handlers
    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing || !containerRef.current) return;

            const container = containerRef.current;
            const containerRect = container.getBoundingClientRect();
            const containerWidth = containerRect.width;
            const mouseX = e.clientX - containerRect.left;
            
            let newLeftWidth = (mouseX / containerWidth) * 100;
            
            // Apply constraints
            newLeftWidth = Math.max(MIN_LEFT_WIDTH, Math.min(100 - MIN_RIGHT_WIDTH, newLeftWidth));
            
            setLeftPaneWidth(newLeftWidth);
        };

        const handleMouseUp = () => {
            if (isResizing) {
                setIsResizing(false);
                localStorage.setItem('youtnote-plugin__notes-left-pane-width', leftPaneWidthRef.current.toString());
            }
        };

        if (isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    const playerSection = (
        <div className="youtnote-plugin__player-container">
            <iframe
                ref={iframeRef}
                className={classNames('youtnote-plugin__iframe', {
                    'youtnote-plugin__iframe-hidden': !activeVideo,
                })}
                allow="autoplay"
            />
            {!activeVideo && (
                <div className="youtnote-plugin__empty-state">
                    {videos.length === 0 ? "Add a video to get started" : "Select a video"}
                </div>
            )}
            {activeVideo && !isPlayerReady && (
                <div className="youtnote-plugin__loading-container">
                    <div className="youtnote-plugin__dot-pulse"></div>
                    <div className="youtnote-plugin__loading-text">Loading video player...</div>
                </div>
            )}
        </div>
    );

    return (
        <div 
            ref={containerRef}
            className={classNames('youtnote-plugin__plugin-container', {
                'youtnote-plugin__iframe-sticky': isStickyEnabled,
                'youtnote-plugin__is-resizing': isResizing,
                'youtnote-plugin__disabled': !isPlayerReady,
            })}
        >
            {/* Left Pane / Top Column */}
            <div 
                className="youtnote-plugin__video-pane" 
                style={{ width: `${leftPaneWidth}%` }}
            >
                {playerSection}
                
                <div className="youtnote-plugin__video-list-header">
                    <div className="youtnote-plugin__video-list-header-content">
                        Videos: <span>{videos.length}</span>
                    </div>
                    {videos.length > 0 && notes.length > 0 && (
                        <button
                            ref={exportAllButtonRef}
                            className="youtnote-plugin__export-btn"
                            onClick={() => onExportAllVideos()}
                            aria-label="Export the notes of all videos as Markdown"
                        />
                    )}
                </div>
                <div className="youtnote-plugin__video-list" ref={videoListRef}>
                    {videos.map(v => (
                        <VideoListItem
                            key={v.id}
                            app={app}
                            video={v}
                            isActive={activeVideoId === v.id}
                            onSelect={setActiveVideoId}
                            onDelete={deleteVideo}
                        />
                    ))}
                </div>
                
                <form className="youtnote-plugin__add-video-form" onSubmit={handleAddVideoSubmit}>
                    <input 
                        type="url" 
                        className="youtnote-plugin__add-video-input" 
                        placeholder="YouTube URL..." 
                        value={newVideoUrl}
                        onChange={(e) => setNewVideoUrl(e.target.value)}
                        disabled={isFetchingMetadata}
                    />
                    <button
                        ref={(el) => {
                            if (el) {
                                el.empty();
                                setIcon(el, isFetchingMetadata? 'hourglass': 'plus')
                            }
                        }}
                        type="submit"
                        className="youtnote-plugin__add-btn youtnote-plugin__add-video-submit"
                        disabled={isFetchingMetadata}
                    >
                    </button>
                </form>
            </div>

            {/* Resize Handle */}
            <div 
                className="youtnote-plugin__resize-handle"
                onMouseDown={handleMouseDown}
            >
                <div className="youtnote-plugin__resize-handle-line" />
            </div>

            {/* Right Pane / Bottom Column */}
            <div 
                className="youtnote-plugin__notes-pane"
                style={{ width: `${100 - leftPaneWidth}%` }}
            >
                <div className="youtnote-plugin__note-list-header">
                    <div className="youtnote-plugin__note-list-header-content">
                        Notes: <span>{activeVideoNotes.length}</span>
                        {settings.showNoteStats && activeVideoNotes.length > 0 && (
                            <>
                                {' • '}
                                Total words: <span>{activeVideoStats.words}</span>
                                {' • '}
                                Total characters: <span>{activeVideoStats.characters}</span>
                            </>
                        )}
                    </div>
                    {activeVideoId && activeVideoNotes.length > 0 && (
                        <div className="youtnote-plugin__note-list-header-actions">
                            <div className="youtnote-plugin__note-list-action-btns-container">
                                <button
                                    ref={mergeNotesButtonRef}
                                    className="youtnote-plugin__merge-notes-btn"
                                    onClick={handleMergeDuplicateNotes}
                                    aria-label="Merge notes with the same timestamp"
                                />
                                <button
                                    ref={exportButtonRef}
                                    className="youtnote-plugin__export-btn"
                                    onClick={() => onExportSingleVideo(activeVideoId)}
                                    aria-label="Export the notes of selected video as Markdown"
                                />
                            </div>
                        </div>
                    )}
                </div>
                <div className="youtnote-plugin__notes-list">
                    {activeVideoNotes.map(note => (
                        <div
                            key={note.id}
                            ref={note.id === newlyCreatedNoteId ? (el: HTMLDivElement | null) => {
                                if (el) {
                                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                    setNewlyCreatedNoteId(null);
                                }
                            } : undefined}
                        >
                            <NoteListItem
                                app={app}
                                view={view}
                                note={note}
                            isExpanded={expandedNotes.has(note.id)}
                            isActive={activeNoteId === note.id}
                            isEditing={editingNoteId === note.id}
                            editingTimestampId={editingTimestampId}
                            editTimestampValue={editTimestampValue}
                            timestampError={timestampError}
                            editNoteBody={editNoteBody}
                            maxDuration={activeVideo?.durationSec || 0}
                            newLineTrigger={settings.newLineTrigger}
                            onToggleExpand={handleNoteClick}
                            onSelect={handleNoteSelect}
                            onStartEdit={(noteId, body) => { setEditingNoteId(noteId); setEditNoteBody(body); }}
                            onSaveEdit={saveNoteEdit}
                            onBodyChange={setEditNoteBody}
                            onStartTimestampEdit={(noteId, value) => { setEditingTimestampId(noteId); setEditTimestampValue(value); }}
                            onSaveTimestampEdit={saveTimestampEdit}
                            onCancelTimestampEdit={cancelTimestampEdit}
                            onTimestampChange={handleTimestampChange}
                            onDelete={deleteNote}
                        />
                        </div>
                    ))}
                </div>
                <button 
                    ref={(el) => {
                        if (el) {
                            el.empty();
                            setIcon(el, 'plus');
                        }
                    }}
                    className="youtnote-plugin__add-btn youtnote-plugin__add-note-btn" 
                    onClick={handleAddNote}
                >
                </button>
            </div>
        </div>
    );
};