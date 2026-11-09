// Runs in the minimal editor runtime: block diffs drawn by the real Scratch Blocks from the real VM's blocks.
import {createScratchBlocksDiffRenderer, openProjectComparison} from '../dist/index.js';
import style from '../dist/style.css';

globalThis.compare = async ({before, after}) => {
    const runtime = await EditorRuntime.start(document.getElementById('workspace'), {locale: 'en'});
    document.head.append(Object.assign(document.createElement('style'), {textContent: style}));
    const renderBlock = createScratchBlocksDiffRenderer({getBlockly: runtime.getBlockly, deserializeBlocks: runtime.deserializeBlocks,
        createBlockContainer: runtime.createBlockContainer, showUnregisteredBlocks: true, locale: 'en'});
    globalThis.choice = openProjectComparison(document, {title: 'Compare', sections: [{title: 'Changes in the folder', before, after}],
        actions: [{id: 'keep', label: 'Keep'}, {id: 'discard', label: 'Discard'}], renderBlock, locale: 'en'});
};
