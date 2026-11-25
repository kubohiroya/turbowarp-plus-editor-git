import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#ff4500"/></svg>';
const assetId = createHash('md5').update(svg).digest('hex');
const md5ext = assetId + '.svg';
const state = {variables: {}, lists: {}, broadcasts: {}, comments: {}, sounds: [], currentCostume: 0, volume: 100,
    costumes: [{name: 'Circle', assetId, dataFormat: 'svg', md5ext, rotationCenterX: 12, rotationCenterY: 12}]};
const block = (opcode, next, parent, inputs = {}) => ({
    opcode, next, parent, inputs, fields: {}, shadow: false, topLevel: parent === null,
    ...(parent === null ? {x: 10, y: 10} : {})
});
const source = (steps, turn) => JSON.stringify({
    targets: [{...state, isStage: true, name: 'Stage', blocks: {}}, {
        ...state, isStage: false, name: 'Walker', x: 0, y: 0, visible: true, size: 100, direction: 90, rotationStyle: 'all around',
        blocks: {
            flag: block('event_whenflagclicked', 'move', null),
            move: block('motion_movesteps', 'turn', 'flag', {STEPS: [1, [4, String(steps)]]}),
            turn: block('motion_turnright', null, 'move', {DEGREES: [1, [4, String(turn)]]})
        }
    }],
    monitors: [], extensions: [], meta: {semver: '3.0.0'}
}, null, 2) + '\n';

export async function mergePlanFixture(t, folder = 'projects/demo') {
    const root = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'twgit-merge-plan-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trimEnd();
    const project = path.join(root, folder);
    const write = (file, contents) => writeFile(path.join(project, file), contents);
    const put = (steps, turn) => write('project.source.json', source(steps, turn));
    const commit = message => {
        git('add', '--all');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Merge fixture');
    git('config', 'user.email', 'merge@example.invalid');
    await mkdir(path.join(project, 'assets'), {recursive: true});
    await mkdir(path.join(project, 'extensions'));
    await mkdir(path.join(project, '.tw-plus'));
    await write('assets/' + md5ext, svg);
    await write('sb3-source.json', JSON.stringify({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets',
        archiveEntries: ['project.json', md5ext, 'tw-plus/workspace.json']}));
    await write('embedded-extensions.json', '{"formatVersion":1,"extensions":[]}');
    await write('.tw-plus/workspace.json', '{}');
    await write('README.md', 'A local project\n');
    await put(10, 15);
    const base = commit('Base project');
    git('switch', '-qc', 'incoming');
    await put(25, 15);
    const incoming = commit('Walk 25 steps');
    git('update-ref', 'refs/remotes/origin/main', incoming);
    git('switch', '-q', 'main');
    await put(10, 30);
    const head = commit('Turn 30 degrees');
    await write('README.md', 'A staged edit\n');
    git('add', '--', path.join(folder, 'README.md'));
    await put(55, 30);
    await write('notes.txt', 'untracked text\n');
    const snapshot = async () => ({
        status: git('--no-optional-locks', 'status', '--porcelain'),
        refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
        index: await readFile(path.join(root, '.git/index')),
        gitHead: await readFile(path.join(root, '.git/HEAD')),
        project: await readFile(path.join(project, 'project.source.json')),
        objects: git('count-objects'),
        mergeHead: await readFile(path.join(root, '.git/MERGE_HEAD')).catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        })
    });
    return {root, project, folder, git, base, head, incoming, put, commit, snapshot};
}
