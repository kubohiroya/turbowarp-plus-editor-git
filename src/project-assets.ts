import {useEffect, useState} from 'react';
import {isRecord} from './project-source-patch.js';
import type {ProjectTarget} from './project-source-patch.js';

export type ProjectVersion = 'before' | 'after';

/**
 * Reads one asset of one version of a project file by its `md5ext` name (for example `0123…cdef.svg`), from the
 * assets directory of that project. Resolves `null` when that version has no readable file of that name.
 */
export type ProjectAssetLoader = (request: {version: ProjectVersion; md5ext: string; signal: AbortSignal}) => Promise<Blob | null>;

const imageTypes: Record<string, string> = {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
};

/** The costume a sprite shows, or the backdrop the stage shows, when the project data names an image file for it. */
export function currentCostume(target: ProjectTarget): {name: string; md5ext: string; type: string} | null {
    const {costumes, currentCostume: index} = target as unknown as Record<string, unknown>;
    if (!Array.isArray(costumes)) return null;
    const costume: unknown = costumes[typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0];
    if (!isRecord(costume)) return null;
    const md5ext = typeof costume.md5ext === 'string' ? costume.md5ext :
        typeof costume.assetId === 'string' && typeof costume.dataFormat === 'string' ? costume.assetId + '.' + costume.dataFormat : '';
    // Asset names are plain file names; anything else could address a path outside the assets directory.
    const match = /^[0-9A-Za-z_-]{1,128}\.([0-9A-Za-z]{1,8})$/.exec(md5ext);
    const type = match ? imageTypes[match[1].toLowerCase()] : undefined;
    if (!type) return null;
    return {name: typeof costume.name === 'string' ? costume.name : '', md5ext, type};
}

// Thumbnails of one target appear in its heading and in each of its frames, so one read serves all of them.
const reads = new WeakMap<ProjectAssetLoader, Map<string, Promise<Blob | null>>>();
function readAsset(loadAsset: ProjectAssetLoader, version: ProjectVersion, md5ext: string) {
    let cache = reads.get(loadAsset);
    if (!cache) reads.set(loadAsset, cache = new Map());
    const key = version + ':' + md5ext;
    let read = cache.get(key);
    if (!read) {
        read = loadAsset({version, md5ext, signal: new AbortController().signal}).catch(() => null);
        cache.set(key, read);
    }
    return read;
}

/** The image type of an asset file name, or `undefined` for sounds and anything that is not an image. */
export function assetImageType(md5ext: string): string | undefined {
    const match = /^[0-9A-Za-z_-]{1,128}\.([0-9A-Za-z]{1,8})$/.exec(md5ext);
    return match ? imageTypes[match[1].toLowerCase()] : undefined;
}

/** Loads one image asset of one version as an object URL, or `null` while it is unavailable or not an image. */
export function useAssetImage(md5ext: string | undefined, version: ProjectVersion, loadAsset?: ProjectAssetLoader): string | null {
    const type = md5ext ? assetImageType(md5ext) : undefined;
    const key = md5ext && type && loadAsset ? version + ':' + md5ext : '';
    const [image, setImage] = useState<{key: string; url: string}>();
    useEffect(() => {
        if (!key || !loadAsset) return;
        let active = true;
        let url: string | undefined;
        void readAsset(loadAsset, version, md5ext!).then(blob => {
            if (!blob || !active) return;
            url = URL.createObjectURL(new Blob([blob], {type}));
            setImage({key, url});
        });
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [key, loadAsset]);
    return image?.key === key ? image.url : null;
}

/** Loads the current costume of one version of a target as an object URL for an image, or `null` while it is unavailable. */
export function useCostumeImage(target: ProjectTarget | undefined, version: ProjectVersion, loadAsset?: ProjectAssetLoader): string | null {
    const costume = target && loadAsset ? currentCostume(target) : null;
    return useAssetImage(costume?.md5ext, version, loadAsset);
}
