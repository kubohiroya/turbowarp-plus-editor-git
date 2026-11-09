import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {BlockPart, BlockSide} from './project-source-patch.js';
import type {BlockPreviewView, ProjectBlockRenderer, ProjectBlockRendering, ScriptBlockMark} from './scratch-block-diff-renderer.js';
import {currentCostume, useCostumeImage} from './project-assets.js';
import type {ProjectAssetLoader, ProjectVersion} from './project-assets.js';

export type LocationStatus = 'locating' | 'located' | 'missingLocation';
type PreviewLabels = Record<'absent' | 'loading' | 'unavailable', string> & Partial<Record<LocationStatus | 'locate', string>>;

/** Keeps the previews of one comparison at the same zoom, height and scroll position while they are linked. */
export interface PreviewSync {
    add(view: BlockPreviewView): () => void;
    setLinked(linked: boolean): void;
}

export function createPreviewSync(): PreviewSync {
    const members = new Map<BlockPreviewView, () => void>();
    let linked = true;
    let moving = false;
    // The version that needs the smaller zoom and the taller frame decides, so neither one is cut off.
    const align = () => {
        if (!linked || !members.size) return;
        const views = [...members.keys()];
        const fit = {scale: Math.min(...views.map(view => view.fit.scale)), height: Math.max(...views.map(view => view.fit.height))};
        for (const view of views) view.layout(fit);
    };
    return {
        add(view) {
            const stop = view.onChange(() => {
                if (!linked || moving) return;
                moving = true;
                try {
                    const viewport = view.viewport();
                    for (const other of members.keys()) if (other !== view) other.setViewport(viewport);
                } finally {
                    moving = false;
                }
            });
            members.set(view, stop);
            align();
            return () => {
                stop();
                members.delete(view);
            };
        },
        setLinked(value) {
            if (linked === value) return;
            linked = value;
            align();
        }
    };
}

const linkLabels = {en: 'Move both versions together', ja: '変更前と変更後を連動して動かす'};

/** One sync group per comparison, with the checkbox that links or unlinks its previews. */
export function usePreviewSync(locale: string) {
    const sync = useMemo(createPreviewSync, []);
    const [linked, setLinked] = useState(true);
    useEffect(() => sync.setLinked(linked), [sync, linked]);
    const toggle = <label className="twgit-block-diff-link"><input type="checkbox" checked={linked}
        onChange={event => setLinked(event.currentTarget.checked)}/> {locale.startsWith('ja') ? linkLabels.ja : linkLabels.en}</label>;
    return {sync, toggle};
}

const rendering = (result: ProjectBlockRendering) =>
    typeof result === 'function' ? {release: result} : {release: result && (() => result.dispose()), view: result?.view};

export function BlockPreview({side, title, parts, marks, renderBlock, withContext, labels, onLocate, locationStatus,
    version, loadAsset, sync}: {
    side?: BlockSide; title: string; parts?: readonly BlockPart[]; marks?: readonly ScriptBlockMark[]; renderBlock: ProjectBlockRenderer;
    withContext: boolean; labels: PreviewLabels; onLocate?: () => void; locationStatus?: LocationStatus;
    /** Which version this preview shows, for its costume thumbnail. */
    version?: ProjectVersion; loadAsset?: ProjectAssetLoader; sync?: PreviewSync;
}) {
    const host = useRef<HTMLDivElement>(null);
    const watermark = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
    const thumbnail = !!(side && version && loadAsset && currentCostume(side.target));
    const image = useCostumeImage(thumbnail ? side!.target : undefined, version ?? 'after', loadAsset);
    useEffect(() => {
        if (!side || !host.current) return;
        const container = host.current;
        const abort = new AbortController();
        let dispose: (() => void) | undefined;
        setStatus('loading');
        void Promise.resolve().then(() => renderBlock({...side, container, withContext, parts, marks, signal: abort.signal,
            watermark: thumbnail ? watermark.current ?? undefined : undefined})).then(result => {
            const {release, view} = rendering(result);
            if (abort.signal.aborted) {
                release?.();
                return;
            }
            const leave = view && sync?.add(view);
            dispose = () => {
                leave?.();
                release?.();
            };
            setStatus('ready');
        }, () => {if (!abort.signal.aborted) setStatus('failed');});
        return () => {abort.abort(); dispose?.();};
    }, [side, renderBlock, withContext, parts, marks, sync, thumbnail]);
    return <div className="twgit-block-diff-side">
        <h4>{title}</h4>
        {!side && <p>{labels.absent}</p>}
        {side && status === 'loading' && <p role="status">{labels.loading}</p>}
        {side && status === 'failed' && <p role="status">{labels.unavailable}</p>}
        {side && <div ref={host} className="twgit-block-diff-preview">
            {thumbnail && <div ref={watermark} className="twgit-block-diff-watermark" data-dockview-costume-thumbnail="">
                {image && <img src={image} alt=""/>}
            </div>}
        </div>}
        {side && onLocate && <button type="button" aria-label={`${title} · ${labels.locate}`}
            onClick={onLocate}>{labels.locate}</button>}
        {locationStatus && <p role="status">{labels[locationStatus]}</p>}
    </div>;
}
