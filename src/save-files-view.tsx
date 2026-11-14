import React, {useEffect, useState} from 'react';
import {FileDiffView} from './file-diff-view.js';
import {FileIdentity} from './file-presentation.js';
import {GitPanelError} from './filesystem.js';
import type {labelsFor} from './messages.js';
import type {Repository, Snapshot} from './repository.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';

type Preview = Awaited<ReturnType<Repository['readUnsavedDiff']>>;

export function SaveFilesView({repository, snapshot, project, unsavedPaths, paths, busy, locale, labels, readUnsaved, renderBlock, onSave}: {
    repository: Repository; snapshot: Snapshot; project: string | null; unsavedPaths: ReadonlySet<string>;
    paths: readonly string[]; busy: boolean; locale: string; labels: ReturnType<typeof labelsFor>;
    readUnsaved?(path: string): Uint8Array | null | undefined;
    renderBlock?: ProjectBlockRenderer; onSave?(): void;
}) {
    const [selected, setSelected] = useState<{repository: Repository; project: string | null; path: string}>();
    const path = selected?.repository === repository && selected.project === project && paths.includes(selected.path) ?
        selected.path : undefined;
    const [preview, setPreview] = useState<{path: string; snapshot: Snapshot; result: Preview | string}>();
    const result = preview?.path === path && preview?.snapshot === snapshot ? preview.result : undefined;
    useEffect(() => {
        if (!path || !readUnsaved || busy) return;
        let active = true;
        const relative = project ? path.slice(project.length + 1) : path;
        const read = async () => {
            const bytes = readUnsaved(relative);
            return bytes === undefined ? labels.unsavedDiffUnavailable : repository.readUnsavedDiff(snapshot, path, bytes);
        };
        const show = (result: Preview | string) => {if (active) setPreview({path, snapshot, result});};
        void read().then(show, error => show(error instanceof GitPanelError && error.code === 'changed' ?
            labels.changed : labels.unsavedDiffUnavailable));
        return () => {active = false;};
    }, [repository, snapshot, project, path, readUnsaved, unsavedPaths, busy, labels]);
    return <div className="twgit-content">
        <aside className="twgit-save-files">
            {paths.length ? <>
                <ul className="twgit-file-state-list">{paths.map(name => <li key={name}>
                    {readUnsaved ? <button className="twgit-file twgit-file-entry" type="button" disabled={busy}
                        aria-pressed={name === path} onClick={() => setSelected({repository, project, path: name})}>
                        <FileIdentity path={name}/>
                    </button> : <FileIdentity path={name}/>}
                </li>)}</ul>
                {onSave && <button className="twgit-primary" type="button" disabled={busy} onClick={onSave}>{labels.saveFiles}</button>}
            </> : <p>{labels.noUnsavedFiles}</p>}
        </aside>
        <main className="twgit-diff twgit-save-diff">
            {typeof result === 'string' ? <p role="status">{result}</p> :
                result ? <FileDiffView key={result.change.path} change={result.change} diff={result.diff} locale={locale}
                    labels={labels} renderBlock={renderBlock} unsaved/> :
                    path ? <p role="status">{labels.unsavedDiffLoading}</p> :
                        paths.length > 0 && readUnsaved && <p>{labels.selectUnsaved}</p>}
        </main>
    </div>;
}
