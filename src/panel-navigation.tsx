import React from 'react';
import type {labelsFor} from './messages.js';
import type {Snapshot} from './repository.js';

export const panelViews = ['save', 'changes', 'history', 'github'] as const;
export type PanelView = typeof panelViews[number];
type Labels = ReturnType<typeof labelsFor>;

const iconPaths = {
    repository: 'M6 20h12V3H6a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h12 M6 7h8 M6 10h5 M8 18v4l2-1.3 2 1.3v-4',
    choose: 'M2 5.5h7l2 2h10v11H2z M2 9h19',
    refresh: 'M20 9a8 8 0 0 0-14-3L3 9m0-5v5h5m-4 6a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
    reload: 'M13 3H5v18h14v-8 M13 3v5h5 M13 3l5 5m2 0a4 4 0 1 1-4 4m4-7v3h-3',
    changes: 'M13 3H5v18h14V9z M13 3v6h6 M8 12h4m-2-2v4m-2 3h6',
    save: 'M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
    commit: 'M2 12h5m10 0h5 M17 12a5 5 0 1 1-10 0 5 5 0 1 1 10 0z',
    openWindow: 'M12 4h8v8m0-8-9 9 M9 6H4v14h14v-5',
    tag: 'M3 3h8l10 10-8 8L3 11z M7 7h.01',
    globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0z M2 12h20 M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z',
    github: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.58 9.58 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z'
} as const;

export function PanelIcon({name}: {name: keyof typeof iconPaths}) {
    return <svg className="twgit-panel-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path d={iconPaths[name]} fill={name === 'github' ? 'currentColor' : 'none'}
            stroke={name === 'github' ? undefined : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>;
}

export function RepositoryIdentity({repositoryName, labels, repositoryAction}: {
    repositoryName?: string; labels: Labels; repositoryAction: React.ReactNode;
}) {
    return <div className="twgit-context-item">
        <PanelIcon name="repository"/><span>{labels.repository}: <strong>{repositoryName ?? '—'}</strong></span>
        {repositoryAction}
    </div>;
}

export function GitWorkflow({id, snapshot, unsavedFiles, savedFiles, active, onSelect, labels}: {
    id: string; snapshot: Snapshot | null; unsavedFiles: number; savedFiles: number;
    active: PanelView; onSelect(view: PanelView): void; labels: Labels;
}) {
    const steps = [
        {label: labels.saveStep, icon: 'save', view: 'save', count: unsavedFiles},
        {label: labels.reviewStep, icon: 'commit', view: 'changes', count: savedFiles},
        {label: labels.recordStep, icon: 'changes', view: 'history', count: undefined},
        {label: labels.shareStep, icon: 'github', view: 'github', count: undefined}
    ] as const;
    return <ol className="twgit-workflow" aria-label={labels.workflow}>
        {steps.map(({label, icon, view, count}) => <li key={view} aria-current={active === view ? 'step' : undefined}>
            <button type="button" id={`${id}-step-${view}`} aria-label={label}
                aria-controls={`${id}-view-${view}`} aria-expanded={active === view}
                onClick={() => onSelect(view)}>
                <PanelIcon name={icon}/><span>{label}</span>
                {snapshot && count !== undefined && <span className="twgit-count"
                    data-review-pending={count > 0 || undefined}>{count}</span>}
            </button>
        </li>)}
    </ol>;
}
