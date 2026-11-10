import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {HistoryActionResult} from './history-graph-view.js';
import {labelsFor} from './messages.js';
import type {BranchRefs} from './repository.js';

/** What the branch button shows: the branches of the chosen repository as the Git panel last read them. */
export interface BranchButtonState extends BranchRefs {
    /** Whether a repository has been chosen. */
    repository: boolean;
    /** Whether the host lets the panel switch and create branches. */
    writable: boolean;
    /** Whether the panel is running an operation. */
    busy: boolean;
    /** Whether a project folder is selected in the panel, so a switch can offer to reload it. */
    project: boolean;
}
/** What the branch button asks the Git panel to do. Branch operations resolve as the panel's own buttons do. */
export interface BranchButtonActions {
    open(): void;
    choose(): void;
    /** The panel's Reload Project, which asks before replacing unsaved edits. */
    reload(): void;
    switchBranch(name: string): Promise<HistoryActionResult>;
    /** Creates a branch at HEAD. */
    createBranch(name: string, checkout: boolean): Promise<HistoryActionResult>;
    /** Creates a local branch from `origin/<name>` and switches to it. */
    createFromRemote(name: string): Promise<HistoryActionResult>;
}
export interface BranchButtonProps extends BranchButtonActions {
    state: BranchButtonState;
    locale?: string;
}
interface Item {id: string; label: string; checked?: boolean; disabled?: boolean; separatorBefore?: boolean; run(): void}

const menuItems = '[role="menuitem"], [role="menuitemradio"]';
/** How long a snackbar stays when it is neither hovered nor focused. */
export const snackbarDuration = 6000;
interface Snack {id: number; text: string; alert: boolean; action?: {label: string; run(): void}}

/**
 * A short result at the bottom of the window, with the project folder's status look. It stays while hovered or
 * focused, Escape or the close button dismisses it, and focus is never moved into it.
 */
function Snackbar({snack, closeLabel, onClose}: {snack: Snack; closeLabel: string; onClose(focus: boolean): void}) {
    // Kept outside React state, so a pointer or focus arriving just before the timeout stops it at once.
    const held = useRef({hover: false, focus: false});
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const hold = (change: Partial<typeof held.current>) => {
        held.current = {...held.current, ...change};
        clearTimeout(timer.current);
        if (!held.current.hover && !held.current.focus) timer.current = setTimeout(() => onClose(false), snackbarDuration);
    };
    useEffect(() => {
        hold({});
        return () => clearTimeout(timer.current);
    }, []);
    return createPortal(<div className="twgit-snackbar" data-git-snackbar=""
        onMouseEnter={() => hold({hover: true})} onMouseLeave={() => hold({hover: false})}
        onFocus={() => hold({focus: true})}
        onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold({focus: false});
        }}
        onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose(true);
        }}>
        <span role={snack.alert ? 'alert' : 'status'}>{snack.text}</span>
        {snack.action && <button type="button" onClick={() => {onClose(true); snack.action!.run();}}>{snack.action.label}</button>}
        <button type="button" className="twgit-snackbar-close" aria-label={closeLabel} title={closeLabel}
            onClick={() => onClose(true)}>×</button>
    </div>, document.body);
}

/**
 * The results of branch operations in a snackbar, as the branch button and the history view tell them: a switch with
 * Reload Project while a project folder is selected, a new branch, or the reason for a refusal with Open Local Git.
 * A declined confirmation tells nothing. `restoreFocus` takes the focus back when the snackbar closes from inside.
 */
export function useBranchSnackbar(locale: string, project: boolean, actions: Pick<BranchButtonActions, 'open' | 'reload'>,
    restoreFocus?: () => void) {
    const labels = labelsFor(locale);
    const [snack, setSnack] = useState<Snack | null>(null);
    const snacks = useRef(0);
    const mounted = useRef(true);
    useEffect(() => () => {mounted.current = false;}, []);
    const show = (text: string, alert: boolean, action?: Snack['action']) => {
        if (mounted.current) setSnack({id: ++snacks.current, text, alert, action});
    };
    const report = (result: HistoryActionResult, switched: boolean) => {
        if (result.done) {
            if (!switched) show(labels.branchCreated, false);
            // The switch rewrote the files; the open project shows them after Reload Project.
            else show(labels.switchedShort, false, project ? {label: labels.reload, run: actions.reload} : undefined);
        } else if (result.error) show(result.error, true, {label: labels.openPanel, run: actions.open});
    };
    const element = snack && <Snackbar key={snack.id} snack={snack} closeLabel={labels.close} onClose={focus => {
        setSnack(previous => previous?.id === snack.id ? null : previous);
        // Focus inside the snackbar would be lost with it.
        if (focus) restoreFocus?.();
    }}/>;
    return {report, element};
}

/** Git's branch glyph, drawn in the text color. */
function BranchIcon() {
    return <svg className="twgit-branch-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5.5" r="1.75"/>
            <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.5 2.75-6 3.75"/>
        </g>
    </svg>;
}

/**
 * The current branch as a menu button for the host's menu bar, with the menu of branches. Before a repository is
 * chosen it reads "Git" and offers to choose one. A detached HEAD shows its short commit ID. The menu moves with the
 * arrow keys, Home and End; Escape closes it and returns to the button. Without `writable` it lists the branches only.
 */
export function BranchButton({state, locale = 'en', ...actions}: BranchButtonProps) {
    const labels = labelsFor(locale);
    const [mode, setMode] = useState<'closed' | 'menu' | 'create'>('closed');
    const [initial, setInitial] = useState<'checked' | 'first' | 'last'>('checked');
    const [name, setName] = useState('');
    const [checkout, setCheckout] = useState(true);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const mounted = useRef(true);
    useEffect(() => () => {mounted.current = false;}, []);
    useLayoutEffect(() => {
        const element = popup.current;
        if (!element) return;
        if (mode === 'create') {
            element.querySelector('input')?.focus();
            return;
        }
        const items = [...element.querySelectorAll<HTMLElement>(menuItems)];
        const checked = items.find(item => item.getAttribute('aria-checked') === 'true');
        (initial === 'last' ? items[items.length - 1] : initial === 'checked' && checked || items[0])?.focus();
    }, [mode]);
    // A click elsewhere closes the menu, also where nothing takes the focus.
    useEffect(() => {
        if (mode === 'closed') return;
        const node = root.current!;
        const dismiss = (event: Event) => {
            if (!node.contains(event.target as Node) && !creating) setMode('closed');
        };
        node.ownerDocument.addEventListener('pointerdown', dismiss, true);
        return () => node.ownerDocument.removeEventListener('pointerdown', dismiss, true);
    }, [mode, creating]);
    // After a refused create, the name is selected for correcting.
    useEffect(() => {
        if (!createError || creating) return;
        const input = popup.current?.querySelector('input:not([type])') as HTMLInputElement | null;
        input?.focus();
        input?.select();
    }, [createError, creating]);

    const {branch, head} = state;
    const unborn = state.repository && !head;
    const text = !state.repository ? 'Git' : branch ?? (head ? head.slice(0, 7) : labels.unborn);
    const accessibleName = !state.repository ? labels.title :
        `${branch ? labels.branch : labels.detached}: ${text}${unborn && branch ? ` (${labels.unborn})` : ''}`;
    const close = (focus = true) => {
        setMode('closed');
        if (focus) trigger.current?.focus({preventScroll: true});
    };
    const openMenu = (from: 'checked' | 'first' | 'last') => {
        setInitial(from);
        setMode('menu');
    };
    const {report, element: snackbar} = useBranchSnackbar(locale, state.project, actions,
        () => trigger.current?.focus({preventScroll: true}));
    const change = async (operation: () => Promise<HistoryActionResult>) => report(await operation(), true);
    const items: Item[] = [];
    if (!state.repository) {
        items.push({id: 'choose', label: labels.choose, run: () => {close(); actions.choose();}});
    } else {
        const switching = state.writable && !state.busy;
        for (const local of state.branches) {
            items.push({id: 'branch:' + local, label: local, checked: local === branch, disabled: !state.writable || state.busy && local !== branch,
                run: () => {
                    close();
                    if (local !== branch && switching) void change(() => actions.switchBranch(local));
                }});
        }
        if (state.writable) {
            state.remoteBranches.forEach((remote, index) => items.push({id: 'remote:' + remote,
                label: labels.historyCreateFromRemote.replace('{name}', remote), disabled: state.busy, separatorBefore: index === 0,
                run: () => {
                    close();
                    if (!state.busy) void change(() => actions.createFromRemote(remote));
                }}));
            if (head) items.push({id: 'create', label: labels.newBranchItem, disabled: state.busy, separatorBefore: true, run: () => {
                if (state.busy) return;
                setName('');
                setCheckout(true);
                setCreateError('');
                setMode('create');
            }});
        }
    }
    // "Open Local Git" goes with "New Branch…" and stands apart from the branches.
    items.push({id: 'open', label: labels.openPanel, separatorBefore: items.length > 0 && items[items.length - 1].id !== 'create',
        run: () => {close(); actions.open();}});

    const onMenuKey = (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!creating) close();
            return;
        }
        if (mode !== 'menu') return;
        if (event.key === 'Tab') {close(false); return;}
        const elements = [...event.currentTarget.querySelectorAll<HTMLElement>(menuItems)];
        const index = elements.indexOf(event.target as HTMLElement);
        const target = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: elements.length - 1}[event.key];
        if (target === undefined || !elements.length) return;
        event.preventDefault();
        elements[(target + elements.length) % elements.length].focus();
    };
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        const branchName = name.trim();
        if (!branchName || creating) return;
        setCreating(true);
        setCreateError('');
        let result: HistoryActionResult;
        try {
            result = await actions.createBranch(branchName, checkout);
        } catch (error) {
            result = {done: false, error: error instanceof Error && error.message ? error.message : labels.failed};
        }
        if (!mounted.current) return;
        setCreating(false);
        if (result.done) {
            close();
            report(result, checkout);
        } else setCreateError(result.error ?? '');
    };
    return <div className="twgit-branch-entry" ref={root} onBlur={event => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next) && !creating) setMode('closed');
    }}>
        <button type="button" className="twgit-branch-button" ref={trigger} aria-label={accessibleName} title={accessibleName}
            aria-haspopup="menu" aria-expanded={mode === 'menu'} data-git-branch={state.repository ? branch ?? head ?? '' : undefined}
            onClick={() => mode === 'closed' ? openMenu('checked') : close(false)}
            onKeyDown={event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                event.preventDefault();
                openMenu(event.key === 'ArrowUp' ? 'last' : 'checked');
            }}>
            <BranchIcon/>
            <span className="twgit-branch-name">{text}</span>
            {unborn && branch && <small className="twgit-branch-unborn">{labels.unborn}</small>}
            <span className="twgit-branch-caret" aria-hidden="true">▾</span>
        </button>
        {mode === 'menu' && <div ref={popup} className="twgit-branch-popup" role="menu" aria-label={labels.branchMenu} onKeyDown={onMenuKey}>
            {items.map(item => <button key={item.id} type="button" tabIndex={-1} data-action={item.id}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked}
                aria-disabled={item.disabled || undefined} data-separator-before={item.separatorBefore || undefined}
                onClick={() => {if (!item.disabled || item.checked) item.run();}}>
                {item.checked !== undefined && <span className="twgit-branch-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>}
                {item.label}
            </button>)}
        </div>}
        {mode === 'create' && <div ref={popup} className="twgit-branch-popup" role="dialog" aria-label={labels.newBranchTitle}
            onKeyDown={onMenuKey}>
            <form onSubmit={event => void submit(event)}>
                <label>{labels.newBranch} <input value={name} required disabled={creating} aria-invalid={createError ? true : undefined}
                    onChange={event => setName(event.currentTarget.value)}/></label>
                <label><input type="checkbox" checked={checkout} disabled={creating}
                    onChange={event => setCheckout(event.currentTarget.checked)}/> {labels.switchAfterCreate}</label>
                {createError && <p className="twgit-graph-form-error" role="alert">{createError}</p>}
                <span className="twgit-graph-form-actions">
                    <button type="submit" disabled={creating || state.busy || !name.trim()}>{labels.createBranch}</button>
                    <button type="button" disabled={creating} onClick={() => close()}>{labels.cancel}</button>
                </span>
            </form>
        </div>}
        {snackbar}
    </div>;
}
