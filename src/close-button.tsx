import React from 'react';

/** A button drawn as an X, named by `label` for screen readers and in its tooltip. */
export function CloseButton({label, onClick}: {label: string; onClick(): void}) {
    return <button type="button" className="twgit-close" aria-label={label} title={label} onClick={onClick}>
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
        </svg>
    </button>;
}
