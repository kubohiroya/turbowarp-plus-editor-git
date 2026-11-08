import React, {useEffect, useRef, useState} from 'react';
import type {BlockPart, BlockSide} from './project-source-patch.js';
import type {ProjectBlockRenderer, ScriptBlockMark} from './scratch-block-diff-renderer.js';

export type LocationStatus = 'locating' | 'located' | 'missingLocation';
type PreviewLabels = Record<'absent' | 'loading' | 'unavailable', string> & Partial<Record<LocationStatus | 'locate', string>>;

export function BlockPreview({side, title, parts, marks, renderBlock, withContext, labels, onLocate, locationStatus}: {
    side?: BlockSide; title: string; parts?: readonly BlockPart[]; marks?: readonly ScriptBlockMark[]; renderBlock: ProjectBlockRenderer;
    withContext: boolean; labels: PreviewLabels; onLocate?: () => void; locationStatus?: LocationStatus;
}) {
    const host = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
    useEffect(() => {
        if (!side || !host.current) return;
        const container = host.current;
        const abort = new AbortController();
        let dispose: (() => void) | undefined;
        setStatus('loading');
        void Promise.resolve().then(() => renderBlock({...side, container, withContext, parts, marks, signal: abort.signal})).then(cleanup => {
            if (abort.signal.aborted) cleanup?.();
            else {dispose = cleanup; setStatus('ready');}
        }, () => {if (!abort.signal.aborted) setStatus('failed');});
        return () => {abort.abort(); dispose?.();};
    }, [side, renderBlock, withContext, parts, marks]);
    return <div className="twgit-block-diff-side">
        <h4>{title}</h4>
        {!side && <p>{labels.absent}</p>}
        {side && status === 'loading' && <p role="status">{labels.loading}</p>}
        {side && status === 'failed' && <p role="status">{labels.unavailable}</p>}
        <div ref={host} className="twgit-block-diff-preview"/>
        {side && onLocate && <button type="button" aria-label={`${title} · ${labels.locate}`}
            onClick={onLocate}>{labels.locate}</button>}
        {locationStatus && <p role="status">{labels[locationStatus]}</p>}
    </div>;
}
