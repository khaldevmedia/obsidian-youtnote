import { Notice } from 'obsidian';

export type NoticeSeverity = 'normal' | 'warning' | 'error';

const SEVERITY_CLASSES: Record<Exclude<NoticeSeverity, 'normal'>, string> = {
    warning: 'youtnote-plugin__notice-warning',
    error: 'youtnote-plugin__notice-error',
};

export function showYoutnoteNotice(
    message: string,
    options: { severity?: NoticeSeverity; duration?: number } = {},
): Notice {
    const severity = options.severity ?? 'normal';
    const duration = options.duration ?? (severity === 'normal' ? 3000 : 0);
    const notice = new Notice(message, duration);
    if (severity !== 'normal') {
        notice.messageEl.addClass(SEVERITY_CLASSES[severity]);
    }
    return notice;
}
