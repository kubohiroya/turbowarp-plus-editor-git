import React, {useEffect, useRef} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import {ProjectSourceComparison} from './project-source-review.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

/** One comparison of two project.source.json texts, shown under its own heading. */
export interface ProjectComparisonSection {
    title: string;
    before: string | null;
    after: string | null;
}
export interface ProjectComparisonAction {
    id: string;
    label: string;
}
export interface ProjectComparisonOptions {
    title: string;
    description?: string;
    /** Notes shown after the description, such as edits the comparison cannot show. */
    notes?: readonly string[];
    sections: readonly ProjectComparisonSection[];
    /** The first action is the one the dialog focuses. Closing the dialog or pressing Escape chooses none. */
    actions: readonly ProjectComparisonAction[];
    closeLabel?: string;
    renderBlock: ProjectBlockRenderer;
    locale?: string;
}
export interface ProjectComparisonDialogProps extends ProjectComparisonOptions {
    onChoose(action: string | null): void;
}

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]';

/** A modal that lays project comparisons side by side in sections and asks the user to choose an action. */
export function ProjectComparisonDialog({title, description, notes = [], sections, actions, closeLabel = 'Close',
    renderBlock, locale = 'en', onChoose}: ProjectComparisonDialogProps) {
    const dialog = useRef<HTMLDivElement>(null);
    const first = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const previous = dialog.current?.ownerDocument.activeElement as HTMLElement | null;
        (first.current ?? dialog.current)?.focus();
        return () => {if (previous?.isConnected) previous.focus();};
    }, []);
    const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {event.stopPropagation(); onChoose(null); return;}
        if (event.key !== 'Tab') return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(focusable)].filter(item => item.getClientRects().length > 0);
        const start = items[0], end = items[items.length - 1];
        const active = event.currentTarget.ownerDocument.activeElement;
        if (event.shiftKey && (active === start || active === event.currentTarget)) {event.preventDefault(); end?.focus();}
        else if (!event.shiftKey && active === end) {event.preventDefault(); start?.focus();}
    };
    return <div className="twgit-backdrop">
        <div className="twgit-panel twgit-comparison" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true"
            aria-label={title} onKeyDown={keyDown}>
            <header>
                <h2>{title}</h2>
                <button type="button" onClick={() => onChoose(null)}>{closeLabel}</button>
            </header>
            <div className="twgit-comparison-body">
                {description && <p>{description}</p>}
                {notes.map(note => <p key={note} role="note">{note}</p>)}
                {sections.map(section => <section key={section.title} aria-label={section.title} data-twgit-comparison="">
                    <h3>{section.title}</h3>
                    <ProjectSourceComparison before={section.before} after={section.after} renderBlock={renderBlock} locale={locale}/>
                </section>)}
            </div>
            <footer className="twgit-comparison-actions">
                {actions.map((action, index) => <button key={action.id} type="button" ref={index === 0 ? first : undefined}
                    data-twgit-action={action.id} onClick={() => onChoose(action.id)}>{action.label}</button>)}
            </footer>
        </div>
    </div>;
}

/** Shows {@link ProjectComparisonDialog} and resolves with the chosen action's id, or `null` when it is closed. */
export function openProjectComparison(document: Document, options: ProjectComparisonOptions): Promise<string | null> {
    const root = document.createElement('div');
    document.body.append(root);
    return new Promise(resolve => {
        const choose = (action: string | null) => {
            unmountComponentAtNode(root);
            root.remove();
            resolve(action);
        };
        render(<ProjectComparisonDialog {...options} onChoose={choose}/>, root);
    });
}
