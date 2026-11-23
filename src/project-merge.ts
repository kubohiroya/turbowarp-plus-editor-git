/**
 * Three-way merge of Scratch project folders, without a user interface or Git access. The caller supplies the three
 * versions of each file (the merge base, the current branch and the incoming branch) and gets the merged files to
 * start from, the conflicts, and a function that applies the chosen side for each conflict.
 */
export {
    mergeProjectFolder, resolveProjectFolder, projectAssetNames, sameBytes,
    type FileBytes, type FileVersions, type FolderConflict, type FileMergeKind, type FileMergeResult,
    type FolderMergeResult, type FolderResolution
} from './project-folder-merge.js';
export {
    mergeProjectSource, resolveProjectSource, applyConflict, checkProject, formatProjectSource, parseSourceProject,
    type SourceProject, type SourceTarget, type MergeSide, type ProjectConflict, type ProjectConflictKind,
    type ProjectConflictLocation, type ProjectMergeResult, type ProjectProblem
} from './project-source-merge.js';
export {
    mergeJson, readJsonPath, writeJsonPath, type JsonPath, type JsonConflict, type JsonMergeOptions, type JsonMergeResult
} from './merge-json.js';
export {mergeText, renderText, splitLines, type TextChunk, type TextMergeResult, type TextSide} from './merge-text.js';
