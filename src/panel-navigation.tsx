import React from 'react';
import type {labelsFor} from './messages.js';
import type {Snapshot} from './repository.js';

export const panelTabs = ['changes', 'history', 'github'] as const;
export type PanelTab = typeof panelTabs[number];
type Labels = ReturnType<typeof labelsFor>;

export function PanelTabs({id, active, onSelect, labels}: {
    id: string; active: PanelTab; onSelect(tab: PanelTab): void; labels: Labels;
}) {
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const index = panelTabs.indexOf(active);
        let next: number;
        switch (event.key) {
        case 'ArrowLeft': next = (index + panelTabs.length - 1) % panelTabs.length; break;
        case 'ArrowRight': next = (index + 1) % panelTabs.length; break;
        case 'Home': next = 0; break;
        case 'End': next = panelTabs.length - 1; break;
        default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        onSelect(panelTabs[next]);
        (event.currentTarget.children[next] as HTMLButtonElement).focus();
    };
    return <div className="twgit-tabs" role="tablist" aria-label={labels.title} onKeyDown={onKeyDown}>
        {panelTabs.map(tab => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`}
            aria-controls={`${id}-view-${tab}`} aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
            onClick={() => onSelect(tab)}>{labels[`${tab}Tab`]}</button>)}
    </div>;
}

export function GitWorkflow({snapshot, dirty, canRecord, canShare, labels}: {
    snapshot: Snapshot | null; dirty: boolean; canRecord: boolean; canShare: boolean; labels: Labels;
}) {
    const unrecorded = snapshot?.changes.some(change => change.group !== 'staged');
    const recorded = !!snapshot?.head && snapshot.changes.length === 0;
    const saved = !!snapshot && !dirty;
    const share = canShare && snapshot?.upstream.state === 'ahead';
    // The current step follows the working tree even while the person browses history or GitHub.
    const current = !snapshot ? null : dirty ? 'saveStep' : unrecorded ? 'reviewStep' :
        snapshot.changes.length && canRecord ? 'recordStep' : recorded && share ? 'shareStep' : null;
    const steps = [
        {key: 'saveStep', done: saved},
        {key: 'reviewStep', done: saved && !unrecorded},
        {key: 'recordStep', done: saved && recorded},
        {key: 'shareStep', done: saved && recorded && snapshot?.upstream.state === 'same', optional: true}
    ] as const;
    return <ol className="twgit-workflow" aria-label={labels.workflow}>
        {steps.map(step => <li key={step.key} aria-current={step.key === current ? 'step' : undefined}
            data-complete={step.done || undefined}>
            <span className="twgit-step-mark" role={step.done ? 'img' : undefined}
                aria-label={step.done ? labels.doneStep : undefined} aria-hidden={!step.done}>{step.done ? '✓' : ''}</span>
            <span>{labels[step.key]}{'optional' in step && <small>{labels.optionalStep}</small>}</span>
        </li>)}
    </ol>;
}
