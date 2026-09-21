import type { TFile } from 'obsidian';

export type VideoTaskKind = 'transcript' | 'ai';
export type VideoTaskPhase =
    | 'fetching-tracks'
    | 'choosing-track'
    | 'fetching-captions'
    | 'fetching-transcript'
    | 'generating-notes';

export interface VideoTaskState {
    transcriptPhase: VideoTaskPhase | null;
    aiPhase: VideoTaskPhase | null;
}

export interface VideoTaskTarget {
    file: TFile;
    youtubeId: string;
    videoTitle: string;
}

export interface VideoTaskHandle {
    id: number;
    signal: AbortSignal;
}

interface VideoTaskRecord {
    id: number;
    kind: VideoTaskKind;
    target: VideoTaskTarget;
    phase: VideoTaskPhase;
    controller: AbortController;
}

export class ActiveVideoTaskRegistry {
    private operations = new Map<number, VideoTaskRecord>();
    private nextId = 1;

    constructor(private readonly onChange: () => void) {}

    start(
        kind: VideoTaskKind,
        target: VideoTaskTarget,
        phase: VideoTaskPhase,
    ): VideoTaskHandle | null {
        for (const operation of this.operations.values()) {
            if (
                operation.kind === kind &&
                operation.target.file === target.file &&
                operation.target.youtubeId === target.youtubeId
            ) {
                return null;
            }
        }
        const controller = new AbortController();
        const id = this.nextId++;
        this.operations.set(id, { id, kind, target, phase, controller });
        this.onChange();
        return { id, signal: controller.signal };
    }

    update(id: number, phase: VideoTaskPhase): boolean {
        const operation = this.operations.get(id);
        if (!operation) {
            return false;
        }
        operation.phase = phase;
        this.onChange();
        return true;
    }

    complete(id: number): boolean {
        const operation = this.operations.get(id);
        if (!operation) {
            return false;
        }
        this.operations.delete(id);
        this.onChange();
        return true;
    }

    isActive(id: number): boolean {
        return this.operations.has(id);
    }

    getVideoState(file: TFile, youtubeId: string): VideoTaskState {
        const state: VideoTaskState = {
            transcriptPhase: null,
            aiPhase: null,
        };
        for (const operation of this.operations.values()) {
            if (operation.target.file !== file || operation.target.youtubeId !== youtubeId) {
                continue;
            }
            if (operation.kind === 'transcript') {
                state.transcriptPhase = operation.phase;
            } else {
                state.aiPhase = operation.phase;
            }
        }
        return state;
    }

    cancelTarget(file: TFile, youtubeId: string, kind?: VideoTaskKind): boolean {
        return this.cancelMatching(operation =>
            operation.target.file === file &&
            operation.target.youtubeId === youtubeId &&
            (kind === undefined || operation.kind === kind)
        );
    }

    cancelFile(file: TFile): boolean {
        return this.cancelMatching(operation => operation.target.file === file);
    }

    cancelAll(): boolean {
        if (this.operations.size === 0) {
            return false;
        }
        for (const operation of this.operations.values()) {
            operation.controller.abort();
        }
        this.operations.clear();
        this.onChange();
        return true;
    }

    private cancelMatching(predicate: (operation: VideoTaskRecord) => boolean): boolean {
        const matching: VideoTaskRecord[] = [];
        for (const operation of this.operations.values()) {
            if (predicate(operation)) {
                matching.push(operation);
            }
        }
        if (matching.length === 0) {
            return false;
        }
        for (const operation of matching) {
            this.operations.delete(operation.id);
            operation.controller.abort();
        }
        this.onChange();
        return true;
    }
}
