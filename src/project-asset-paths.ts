// Shared by the local and GitHub asset loaders. Kept free of React so the repository entry stays UI-free.

/** The largest asset a thumbnail reads. */
export const assetLimit = 10 * 1024 * 1024;
/** The largest sb3-source.json read to find the assets directory. */
export const folderSettingsLimit = 1024 * 1024;

/** Asset names are plain `<md5>.<ext>` file names; anything else could address a path outside the assets directory. */
export const isAssetName = (name: unknown): name is string =>
    typeof name === 'string' && /^[0-9A-Za-z_-]{1,128}\.[0-9A-Za-z]{1,8}$/.test(name);

/**
 * The assets directory named by one version of a project folder's `sb3-source.json`, as path segments relative to the
 * folder. `assets` when that file or its `assetsDirectory` field is missing or unreadable. `null` when the field names
 * anything other than a plain relative path inside the folder.
 */
export function assetsDirectoryParts(settings: string | null): string[] | null {
    let value: unknown = 'assets';
    if (settings !== null) {
        try {
            const parsed: unknown = JSON.parse(settings);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'assetsDirectory' in parsed) {
                value = (parsed as {assetsDirectory: unknown}).assetsDirectory;
            }
        } catch {
            // An unreadable file names no directory, as a missing one does.
        }
    }
    if (typeof value !== 'string' || value.length > 1024) return null;
    const parts = value.split('/');
    return parts.every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' &&
        !/[\\\0-\x1f\x7f]/.test(part)) ? parts : null;
}
