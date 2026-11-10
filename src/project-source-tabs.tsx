import React, {useEffect, useRef, useState} from 'react';
import {render, unmountComponentAtNode} from 'react-dom';
import {compareProjectForReview} from './project-source-review-model.js';
import type {TargetReview} from './project-source-review-model.js';
import {reviewTabWords, ScriptReviewTab, TargetReviewTab} from './project-source-review.js';
import type {ProjectSource} from './project-source-patch.js';
import type {ProjectBlockRenderer} from './scratch-block-diff-renderer.js';
import type {ProjectAssetLoader} from './project-assets.js';
import type {ProjectBlockLocator} from './block-diff-location.js';
import type {GitPanelRequest} from './index.js';

/** One project.source.json of a comparison, read into both versions. */
export interface ProjectSourceTabsFile {
    path: string;
    before: ProjectSource;
    after: ProjectSource;
    loadAsset?: ProjectAssetLoader;
    /** Offers "Highlight in Editor" on the after version, which the caller has matched with the open project. */
    locateBlock?: ProjectBlockLocator;
}

export interface ProjectSourceTabsOptions {
    /**
     * Names this comparison, such as `owner/repo#42@<head>` or `<commit>:project.source.json`. Its tabs share one
     * split, and opening the same comparison again brings its tabs forward instead of adding them twice.
     */
    key: string;
    files: readonly ProjectSourceTabsFile[];
    renderBlock: ProjectBlockRenderer;
    locale?: string;
    /**
     * Shares the reviewed marks of the script tabs with the review of this name, such as `owner/repo#42`, and keeps
     * them in the browser. Without it, the marks are kept for this comparison while the page is open.
     */
    rememberAs?: string;
}

const providerId = 'turbowarp-plus-git';
// The chip colour says what happened to the stage or sprite, as the review's status words do.
const statusColor = {added: 'green', removed: 'red', updated: 'blue'} as const;

/** Renders its content once the tab is first shown, so a comparison with many scripts draws only what is looked at. */
function WhenShown({children}: {children: React.ReactNode}) {
    const element = useRef<HTMLDivElement>(null);
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const view = element.current?.ownerDocument.defaultView as (Window & typeof globalThis) | null;
        if (shown || !element.current) return;
        if (!view?.IntersectionObserver) {
            setShown(true);
            return;
        }
        const observer = new view.IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) setShown(true);
        });
        observer.observe(element.current);
        return () => observer.disconnect();
    }, [shown]);
    return <div ref={element} className="twgit-review-tab-body">{shown && children}</div>;
}

/**
 * Opens a comparison of project.source.json files as tabs of the host's workspace: a tab group for each changed
 * stage or sprite, holding a tab for each changed script and one for its changes outside the code.
 * Returns how many tabs were asked for, or `0` when the host has no workspace to take them.
 */
export function openProjectSourceTabs(openPanel: ((request: GitPanelRequest) => boolean) | undefined,
    {key, files, renderBlock, locale = 'en', rememberAs}: ProjectSourceTabsOptions): number {
    if (!openPanel) return 0;
    const words = reviewTabWords(locale);
    const area = `${providerId}:diff:${key}`;
    const requests: GitPanelRequest[] = [];
    const tab = (documentId: string, title: string, content: () => React.ReactElement,
        tabGroup?: GitPanelRequest['tabGroup']): GitPanelRequest => ({
        reference: {providerId, documentId: `diff:${key}:${documentId}`},
        filename: title,
        title,
        transient: true,
        area,
        tabGroup,
        inactive: requests.length > 0,
        mount(element) {
            element.classList.add('twgit-panel-tab', 'twgit-review-tab-slot');
            render(<WhenShown>{content()}</WhenShown>, element);
            return {requestClose: () => {}, dispose: () => { unmountComponentAtNode(element); }};
        }
    });
    for (const file of files) {
        const comparison = compareProjectForReview(file.before, file.after);
        const prefix = files.length > 1 ? file.path.split('/').slice(0, -1).join('/') : '';
        const labelOf = (target: TargetReview) => prefix ? `${prefix}: ${words.target(target)}` : words.target(target);
        if (comparison.properties.length || !comparison.targets.length) {
            const title = prefix ? `${prefix}: ${words.project}` : words.project;
            requests.push(tab(`${file.path}:project`, title, () => <TargetReviewTab comparison={comparison} locale={locale}/>));
        }
        for (const target of comparison.targets) {
            const targetKey = JSON.stringify([file.path, target.isStage, target.name]);
            const tabGroup = {id: `${area}:${targetKey}`, label: labelOf(target), color: statusColor[target.status]};
            if (target.status !== 'updated' || target.properties.length || !target.scripts.length) {
                // The chip names the stage or sprite, so its tabs name only what they show.
                requests.push(tab(`${targetKey}:details`, words.targetDetails,
                    () => <TargetReviewTab comparison={comparison} target={target} locale={locale} loadAsset={file.loadAsset}/>, tabGroup));
            }
            for (const script of target.scripts) {
                requests.push(tab(`${targetKey}:${script.id}`, words.script(script),
                    () => <ScriptReviewTab comparison={comparison} script={script} renderBlock={renderBlock} locale={locale}
                        loadAsset={file.loadAsset} locateBlock={file.locateBlock}
                        mark={{name: rememberAs ?? area, remember: !!rememberAs, file: file.path, target}}/>, tabGroup));
            }
        }
    }
    let opened = 0;
    for (const request of requests) {
        if (!openPanel(request)) break;
        opened++;
    }
    return opened;
}
