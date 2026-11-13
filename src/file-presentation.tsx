import React from 'react';
import type {labelsFor} from './messages.js';
import type {ChangeGroup} from './repository.js';

type Labels = ReturnType<typeof labelsFor>;
const page = 'M5 2.5h9l5 5v14H5z M14 2.5v5h5';
const fileIcons = {
    project: 'M12 2.5l9 4.75v9.5L12 21.5l-9-4.75v-9.5z M3 7.25l9 4.75 9-4.75 M12 12v9.5',
    markdown: 'M2.5 5.5h19v13h-19z M5.5 15v-5l2.5 3 2.5-3v5 M16.5 10v5m-2-2 2 2 2-2',
    text: page + ' M8 11h8m-8 3.5h8m-8 3.5h5',
    data: page + ' M10 10.5H9v3l-1.5 1L9 16v3h1m4-8.5h1v3l1.5 1L15 16v3h-1',
    code: 'M8 6l-5 6 5 6m8-12 5 6-5 6m-2-15-4 18',
    image: 'M2.5 4.5h19v15h-19z M2.5 17l6-6 5 5 3-3 5 5m-4-8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0',
    audio: 'M3 9h4l5-4v14l-5-4H3z M15 8.5a5 5 0 0 1 0 7m3-9.5a8.5 8.5 0 0 1 0 12',
    video: 'M3 4.5h18v15H3z M10 8.5l5.5 3.5-5.5 3.5z',
    file: page
} as const;
type FileKind = keyof typeof fileIcons;
const extensions = new Map<string, FileKind>([
    ...['md', 'markdown', 'mdown', 'mdx'].map(ext => [ext, 'markdown'] as const),
    ...['txt', 'log', 'rst'].map(ext => [ext, 'text'] as const),
    ...['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml'].map(ext => [ext, 'data'] as const),
    ...['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'html', 'css', 'py', 'sh'].map(ext => [ext, 'code'] as const),
    ...['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'ico'].map(ext => [ext, 'image'] as const),
    ...['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a'].map(ext => [ext, 'audio'] as const),
    ...['mp4', 'webm', 'mov', 'm4v', 'ogv'].map(ext => [ext, 'video'] as const)
]);

function fileKind(path: string): FileKind {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const dot = name.lastIndexOf('.');
    if (name === 'project.source.json' || name === 'sb3-source.json' || name.endsWith('.sb3')) return 'project';
    return dot > 0 ? extensions.get(name.slice(dot + 1)) ?? 'file' : 'file';
}

export function FileKindIcon({kind}: {kind: FileKind}) {
    return <span className="twgit-file-icon" data-git-file-kind={kind} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.65"
            strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d={fileIcons[kind]}/></svg>
    </span>;
}

export function FileIdentity({path, id}: {path: string; id?: string}) {
    return <span className="twgit-file-identity">
        <FileKindIcon kind={fileKind(path)}/>
        <span id={id} className="twgit-file-name" title={path}>{path}</span>
    </span>;
}

const statusMarks: Record<ChangeGroup, string> = {staged: '✓', unstaged: '○', untracked: '+', commit: '◆'};

export function GitStatusBadge({group, labels}: {group: ChangeGroup; labels: Labels}) {
    return <span className="twgit-status-badge" data-git-status={group}>
        <span aria-hidden="true" className="twgit-status-mark">{statusMarks[group]}</span>
        {labels.gitStatus[group]}
    </span>;
}
