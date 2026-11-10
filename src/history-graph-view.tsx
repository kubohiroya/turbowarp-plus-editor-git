import React, {useEffect, useMemo, useRef, useState} from 'react';
import {layoutHistory} from './history-graph.js';
import type {GraphRow} from './history-graph.js';
import {labelsFor} from './messages.js';
import type {HistoryCommit} from './repository.js';

/** How a write action ended: `error` is the message to show when it did not run to the end. */
export type HistoryActionResult = {done: true} | {done: false; error?: string};
export interface HistoryGraphProps {
    /** Commits newest first, each child above its parents, as `Repository.history` returns them page by page. */
    commits: readonly HistoryCommit[];
    /** The commit shown as selected. */
    selected?: string | null;
    onSelect(oid: string): void;
    locale?: string;
    /** While true, selecting and the write actions wait; focus and copying still work. */
    busy?: boolean;
    /** Offers **Show more** when there are more commits to read. */
    hasMore?: boolean;
    loadingMore?: boolean;
    onShowMore?(): void;
    /** Local branch names, so `origin/<name>` is offered as a new branch only when there is none yet. */
    localBranches?: readonly string[];
    /**
     * Write actions. Each is offered only when given. The branch form stays open with the name until `onCreateBranch`
     * resolves `{done: true}` (or nothing); `{done: false, error}` or a rejection shows the reason in the form.
     */
    onCreateBranch?(oid: string, name: string, checkout: boolean): void | Promise<void | HistoryActionResult>;
    onSwitchBranch?(name: string): void | Promise<unknown>;
    onCreateFromRemote?(name: string): void | Promise<unknown>;
}

/** Lane colors that read on light and dark backgrounds. */
export const laneColors = ['#2f7ed8', '#d9480f', '#2b9348', '#9c36b5', '#c2255c', '#0c8599', '#b7791f', '#5c7cfa'];
const column = 14, rowHeight = 44, middle = rowHeight / 2;
const x = (index: number) => column / 2 + index * column;

function Lanes({row, width}: {row: GraphRow; width: number}) {
    return <svg className="twgit-graph-lanes" aria-hidden="true" focusable="false" width={width * column} height={rowHeight}
        viewBox={`0 0 ${width * column} ${rowHeight}`}>
        {row.segments.map((segment, index) => {
            const [top, bottom] = segment.part === 'top' ? [0, middle] : [middle, rowHeight];
            const from = x(segment.from), to = x(segment.to), bend = (top + bottom) / 2;
            const d = from === to ? `M${from} ${top}V${bottom}` : `M${from} ${top}C${from} ${bend} ${to} ${bend} ${to} ${bottom}`;
            return <path key={index} d={d} fill="none" stroke={laneColors[segment.color % laneColors.length]} strokeWidth={2}/>;
        })}
        <circle cx={x(row.column)} cy={middle} r={4.5} fill={laneColors[row.color % laneColors.length]}
            stroke="Canvas" strokeWidth={1.5}/>
    </svg>;
}

interface Action {id: string; label: string; run(): void}
type Menu = {oid: string; mode: 'menu' | 'create'};

/**
 * The history as a graph: one row per commit with its lanes drawn in SVG, a button that selects the commit and a
 * button that opens its actions. ArrowUp and ArrowDown move between commits, Home and End to the ends; Enter or
 * Space selects; the context menu key or Shift+F10 opens the actions.
 */
export function HistoryGraph(props: HistoryGraphProps) {
    const {commits, selected = null, onSelect, locale = 'en', busy = false} = props;
    const labels = labelsFor(locale);
    const layout = useMemo(() => layoutHistory(commits), [commits]);
    const rows = useRef<(HTMLButtonElement | null)[]>([]);
    const menuButtons = useRef<(HTMLButtonElement | null)[]>([]);
    const popup = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState<string | null>(null);
    const [menu, setMenu] = useState<Menu | null>(null);
    const [branchName, setBranchName] = useState('');
    const [checkout, setCheckout] = useState(true);
    const [status, setStatus] = useState('');
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const mounted = useRef(true);
    useEffect(() => () => {mounted.current = false;}, []);
    const focusIndex = Math.max(0, commits.findIndex(commit => commit.oid === (active ?? selected)));
    const locals = useMemo(() => new Set(props.localBranches ??
        commits.flatMap(commit => commit.refs.filter(ref => ref.kind === 'branch').map(ref => ref.name))), [commits, props.localBranches]);
    useEffect(() => {
        const element = popup.current;
        if (!element) return;
        element.querySelector<HTMLElement>(menu?.mode === 'create' ? 'input' : '[role="menuitem"]')?.focus();
    }, [menu?.oid, menu?.mode]);
    // After a refused create, the name is selected for correcting.
    useEffect(() => {
        if (!createError || creating) return;
        const input = popup.current?.querySelector('input:not([type])') as HTMLInputElement | null;
        input?.focus();
        input?.select();
    }, [createError, creating]);
    const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(locale, {dateStyle: 'medium', timeStyle: 'short'});
    const refName = (ref: HistoryCommit['refs'][number]) => ref.current && ref.kind === 'branch' ? `${ref.name} (${labels.currentBranch})` : ref.name;
    const closeMenu = (focus: 'menu' | 'row' | false) => {
        const index = commits.findIndex(commit => commit.oid === menu?.oid);
        setMenu(null);
        if (focus && index !== -1) (focus === 'menu' ? menuButtons : rows).current[index]?.focus();
    };
    const actionsFor = (commit: HistoryCommit): Action[] => {
        const actions: Action[] = [];
        if (props.onCreateBranch) actions.push({id: 'create', label: labels.historyCreateHere, run: () => {
            setBranchName('');
            setCheckout(true);
            setCreateError('');
            setMenu({oid: commit.oid, mode: 'create'});
        }});
        for (const ref of commit.refs) {
            if (ref.kind === 'branch' && !ref.current && props.onSwitchBranch) {
                const run = props.onSwitchBranch;
                actions.push({id: 'switch:' + ref.name, label: labels.historySwitch.replace('{name}', ref.name),
                    run: () => {closeMenu('row'); void run(ref.name);}});
            }
            const name = ref.name.slice('origin/'.length);
            if (ref.kind === 'remote' && !locals.has(name) && props.onCreateFromRemote) {
                const run = props.onCreateFromRemote;
                actions.push({id: 'remote:' + name, label: labels.historyCreateFromRemote.replace('{name}', name),
                    run: () => {closeMenu('row'); void run(name);}});
            }
        }
        actions.push({id: 'copy', label: labels.historyCopy, run: () => {
            closeMenu('menu');
            const clipboard = globalThis.navigator?.clipboard;
            Promise.resolve().then(() => clipboard!.writeText(commit.oid))
                .then(() => setStatus(labels.historyCopied), () => setStatus(labels.historyCopyFailed));
        }});
        return actions;
    };
    const onRowKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        const target = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: commits.length - 1}[event.key];
        if (target !== undefined) {
            event.preventDefault();
            rows.current[Math.min(commits.length - 1, Math.max(0, target))]?.focus();
        } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            setMenu({oid: commits[index].oid, mode: 'menu'});
        }
    };
    const onMenuKey = (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!creating) closeMenu('menu');
            return;
        }
        if (menu?.mode !== 'menu') return;
        if (event.key === 'Tab') {setMenu(null); return;}
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
        const index = items.indexOf(event.target as HTMLElement);
        const target = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1}[event.key];
        if (target === undefined || !items.length) return;
        event.preventDefault();
        items[(target + items.length) % items.length].focus();
    };
    // Closes the menu when focus leaves it and its button, such as on a click elsewhere.
    const onMenuBlur = (event: React.FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.parentElement?.contains(next)) setMenu(null);
    };
    const submitBranch = async (event: React.FormEvent, oid: string) => {
        event.preventDefault();
        const name = branchName.trim();
        if (!name || !props.onCreateBranch || creating) return;
        setCreating(true);
        setCreateError('');
        let result: void | HistoryActionResult;
        try {
            result = await props.onCreateBranch(oid, name, checkout);
        } catch (error) {
            result = {done: false, error: error instanceof Error && error.message ? error.message : labels.failed};
        }
        if (!mounted.current) return;
        setCreating(false);
        if (!result || result.done) closeMenu('menu');
        else setCreateError(result.error ?? '');
    };
    rows.current.length = commits.length;
    menuButtons.current.length = commits.length;
    return <div className="twgit-graph">
        <ol className="twgit-graph-list">{commits.map((commit, index) => {
            const row = layout.rows[index];
            const refs = commit.refs.map(refName);
            const name = [commit.message, commit.author, date(commit.timestamp),
                ...(refs.length ? [`${labels.historyRefs}: ${refs.join(', ')}`] : [])].join(', ');
            const open = menu?.oid === commit.oid ? menu : null;
            const actions = open?.mode === 'menu' ? actionsFor(commit) : [];
            return <li key={commit.oid} className="twgit-graph-row">
                <Lanes row={row} width={layout.width}/>
                <button type="button" className="twgit-graph-commit" ref={element => {rows.current[index] = element;}}
                    tabIndex={index === focusIndex ? 0 : -1} aria-pressed={selected === commit.oid} aria-disabled={busy || undefined}
                    aria-label={name} title={commit.oid} data-oid={commit.oid}
                    onFocus={() => setActive(commit.oid)} onKeyDown={event => onRowKey(event, index)}
                    onClick={() => {if (!busy) onSelect(commit.oid);}}>
                    <span className="twgit-graph-subject">{commit.refs.map(ref => <span key={ref.kind + ref.name}
                        className={`twgit-graph-ref twgit-graph-ref-${ref.kind}${ref.current ? ' twgit-graph-ref-current' : ''}`}>
                        {refName(ref)}</span>)}{commit.message}</span>
                    <span className="twgit-graph-meta">{commit.author} · {date(commit.timestamp)}</span>
                </button>
                <button type="button" className="twgit-graph-menu-button" ref={element => {menuButtons.current[index] = element;}}
                    tabIndex={index === focusIndex || open ? 0 : -1} aria-haspopup="menu" aria-expanded={open?.mode === 'menu'}
                    aria-label={`${labels.historyActions}: ${commit.message}`}
                    onClick={() => setMenu(open ? null : {oid: commit.oid, mode: 'menu'})}
                    onKeyDown={event => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            setMenu({oid: commit.oid, mode: 'menu'});
                        }
                    }}>⋯</button>
                {open?.mode === 'menu' && <div ref={popup} className="twgit-graph-popup" role="menu" aria-label={labels.historyActions}
                    onKeyDown={onMenuKey} onBlur={onMenuBlur}>
                    {actions.map(action => <button key={action.id} type="button" role="menuitem" tabIndex={-1} data-action={action.id}
                        disabled={busy && action.id !== 'copy'} onClick={action.run}>{action.label}</button>)}
                </div>}
                {open?.mode === 'create' && <div ref={popup} className="twgit-graph-popup" role="dialog"
                    aria-label={labels.historyCreateHere} onKeyDown={onMenuKey}>
                    <form onSubmit={event => void submitBranch(event, commit.oid)}>
                        <label>{labels.newBranch} <input value={branchName} required disabled={creating}
                            aria-invalid={createError ? true : undefined}
                            onChange={event => setBranchName(event.currentTarget.value)}/></label>
                        <label><input type="checkbox" checked={checkout} disabled={creating}
                            onChange={event => setCheckout(event.currentTarget.checked)}/> {labels.switchAfterCreate}</label>
                        {createError && <p className="twgit-graph-form-error" role="alert">{createError}</p>}
                        <span className="twgit-graph-form-actions">
                            <button type="submit" disabled={creating || busy || !branchName.trim()}>{labels.createBranch}</button>
                            <button type="button" disabled={creating} onClick={() => closeMenu('menu')}>{labels.cancel}</button>
                        </span>
                    </form>
                </div>}
            </li>;
        })}</ol>
        {props.hasMore && props.onShowMore && <button type="button" className="twgit-graph-more"
            disabled={props.loadingMore} onClick={props.onShowMore}>{props.loadingMore ? labels.historyLoading : labels.historyMore}</button>}
        <p className="twgit-graph-status" role="status">{status}</p>
    </div>;
}
