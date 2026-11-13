import React from 'react';
import type {labelsFor} from './messages.js';
import type {Snapshot} from './repository.js';

export const panelViews = ['changes', 'history', 'github'] as const;
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
    github: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.58 9.58 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z'
} as const;

export function PanelIcon({name}: {name: keyof typeof iconPaths}) {
    return <svg className="twgit-panel-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path d={iconPaths[name]} fill={name === 'github' ? 'currentColor' : 'none'}
            stroke={name === 'github' ? undefined : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>;
}

export function RepositoryContext({snapshot, repositoryName, projectPath, dirty, labels, upstream}: {
    snapshot: Snapshot | null; repositoryName?: string; projectPath: string | null;
    dirty: boolean; labels: Labels; upstream?: string;
}) {
    return <div className="twgit-context twgit-repository-context">
        <span className="twgit-context-item">
            <PanelIcon name="repository"/><span>{labels.repository}: <strong>{repositoryName ?? '—'}</strong></span>
        </span>
        <span className="twgit-context-item" data-git-project-path="">
            <span className="twgit-context-icon-label" role="img" aria-label={labels.project} title={labels.project}>
                <PanelIcon name="choose"/>
            </span>
            <span aria-hidden="true">:</span><code>{projectPath === null ? labels.none : '/' + projectPath}</code>
        </span>
        <span className="twgit-context-item" data-git-dirty="">{dirty ? labels.dirty : labels.saved}</span>
        {snapshot && <>
            <span className="twgit-context-item" data-git-upstream={snapshot.upstream.state} title={labels.checkedAt}>
                <PanelIcon name="github"/>{upstream}
            </span>
            <details className="twgit-git-details">
                <summary>{labels.repositoryDetails}</summary>
                <div className="twgit-connection-body">
                    <p>{labels.branch}: <strong>{snapshot.branch || (snapshot.head ? labels.detached : labels.unborn)}</strong></p>
                    <p>{labels.head}: <code>{snapshot.head?.slice(0, 12) ?? '—'}</code></p>
                    <p>{labels.branches}: {snapshot.branches.join(', ') || '—'}</p>
                    <p>{labels.groups}: {labels.gitStaged} / {labels.gitUnstaged} / {labels.gitUntracked}</p>
                    <p>{labels.permissions}</p>
                </div>
            </details>
        </>}
    </div>;
}

export function GitWorkflow({id, snapshot, dirty, canRecord, canShare, staged, changedFiles, reviewPending, active, onSelect, labels}: {
    id: string; snapshot: Snapshot | null; dirty: boolean; canRecord: boolean; canShare: boolean; staged: number;
    changedFiles: number; reviewPending: boolean; active: PanelView; onSelect(view: PanelView): void; labels: Labels;
}) {
    const saved = !!snapshot && !dirty;
    const recorded = !!snapshot?.head && snapshot.changes.length === 0;
    const share = canShare && snapshot?.upstream.state === 'ahead';
    const current = !snapshot ? null : dirty ? 'saveStep' : reviewPending ? 'reviewStep' :
        staged && canRecord ? 'recordStep' : recorded && share ? 'shareStep' : null;
    const steps = [
        {key: 'saveStep', icon: 'save', done: saved},
        {key: 'reviewStep', icon: 'changes', done: saved && !reviewPending, view: 'changes'},
        {key: 'recordStep', icon: 'commit', done: saved && recorded, view: 'history', hint: labels.recordStepHint},
        {key: 'shareStep', icon: 'github', done: saved && recorded && snapshot?.upstream.state === 'same',
            view: 'github', hint: labels.optionalStep}
    ] as const;
    return <ol className="twgit-workflow" aria-label={labels.workflow}>
        {steps.map(step => {
            const view = 'view' in step ? step.view : undefined;
            const content = <>
                {step.done ? <span className="twgit-step-mark" role="img" aria-label={labels.doneStep}>✓</span> :
                    <PanelIcon name={step.icon}/>}
                <span>{labels[step.key]}
                    {'hint' in step && <small>{step.hint}</small>}
                    {step.key === 'recordStep' && canRecord && staged > 0 &&
                        <small>{labels.selectedFiles.replace('{count}', String(staged))}</small>}
                </span>
                {view === 'changes' && snapshot && <span className="twgit-count" aria-hidden="true"
                    data-review-pending={reviewPending || undefined}>{changedFiles}</span>}
            </>;
            return <li key={step.key} aria-current={step.key === current ? 'step' : undefined}
                data-complete={step.done || undefined}>
                {view ? <button type="button" id={`${id}-step-${view}`} aria-label={labels[step.key]}
                    aria-controls={`${id}-view-${view}`} aria-expanded={active === view}
                    aria-describedby={view === 'changes' && snapshot ? `${id}-changes-count` : undefined}
                    onClick={() => onSelect(view)}>{content}</button> : <div className="twgit-workflow-state">{content}</div>}
                {view === 'changes' && snapshot && <span id={`${id}-changes-count`} hidden>
                    {labels.worktree} · {changedFiles}{reviewPending && `. ${labels.reviewPending}`}
                </span>}
            </li>;
        })}
    </ol>;
}
