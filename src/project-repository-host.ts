/**
 * Creating a GitHub repository for the open project, from the Plus Editor: the device-code flow on
 * Desktop, the Cloudflare BFF in the browser, the initial commit in a new working copy, and its push.
 *
 * Moved from the Plus Editor's `site/project-repository-host.ts` (kubohiroya/turbowarp-plus-editor#741).
 * The workflow itself is `./project-repository-creation`; this binds it to a window and to the
 * services the host's build supplies.
 */
import {createProjectRepositoryWorkflow, creationError, repositoryCreationJournal}
    from './project-repository-creation.js';
import type {CreationInteraction, RepositoryCreationInspection, RepositoryCreationProvider, RepositoryDeviceCode, RepositoryReceipt}
    from './project-repository-creation.js';
import type {GitHubCreationAccount, GitHubRepositoryDraft} from './project-repository-creation.js';
import type {GitAuthProvider, GitProxyConnection, GitProxySession} from '@kubohiroya/turbowarp-plus-editor-auth';

type Author = {name: string; email: string};
type Grant = {scope: 'repository-creation'; connection: GitProxyConnection; account: {login: string}; bearer: string;
    expiresAt: number};
type Session = Grant & GitHubCreationAccount;
type Intent = Parameters<RepositoryCreationProvider<Session>['create']>[1];
type WriteGrant = {remote: string; repositoryId: number; session: GitProxySession};
type Target = Omit<WriteGrant, 'session'>;
type Cloudflare = {bffOrigin: string; proxyOrigin: string};
type SeedFile = {path: string; bytes: Uint8Array};
type DiskRepository = Target & {directory: FileSystemDirectoryHandle; operationId: string; signal: AbortSignal};
/** Folders kept in the browser's own storage (OPFS), where the browser cannot pick folders. */
export interface BrowserRepositoryFolders {
    /** Makes a new empty folder named `title`, for the repository with its project folder inside. */
    create(title: string): Promise<FileSystemDirectoryHandle>;
    /** Lets the user choose one of the folders, or resolves with `null`. */
    choose(): Promise<FileSystemDirectoryHandle | null>;
}

export interface DesktopRepositoryCreation {
    getConnection(): Promise<GitProxyConnection>;
    begin(): Promise<RepositoryDeviceCode>;
    finish(): Promise<Grant | null>;
    getGrant(): Promise<Grant | null>;
    authorizeInitialPush(operationId: string, repositoryId: number): Promise<WriteGrant | null>;
    revokeInitialPush?(operationId: string, repositoryId: number, bearer: string): Promise<void>;
    inspectCreation?(operationId: string): Promise<RepositoryCreationInspection>;
    inspectUnknown(operationId: string): Promise<RepositoryReceipt | null>;
    adoptUnknown(operationId: string, repositoryId: number): Promise<RepositoryReceipt | null>;
    disconnect(): Promise<void>;
}

export interface CreationClient {
    connectForCreation(signal: AbortSignal): Promise<Session | null>;
    createRepository: RepositoryCreationProvider<Session>['create'];
    setRepositoryTopics: RepositoryCreationProvider<Session>['topics'];
    inspectCreation?: RepositoryCreationProvider<Session>['inspect'];
    inspectUnknown?(session: Session, operationId: string, signal: AbortSignal): Promise<RepositoryReceipt | null>;
    adoptUnknown?: RepositoryCreationProvider<Session>['adopt'];
}

/**
 * What the host's build supplies. The Plus Editor used to receive these as build-time globals; a
 * host now hands them in, so this module does not depend on how they were bundled.
 */
export interface ProjectRepositoryHostServices {
    createRepositoryClient(options: {connection: GitProxyConnection; authorize(signal?: AbortSignal): Promise<Grant | null>}): CreationClient;
    createCloudflareRepositoryAuth?(options: {bffOrigin: string; openAuthorization(url: string): void}):
        {connection: GitProxyConnection; authorize(signal?: AbortSignal): Promise<Grant | null>; disconnect(): Promise<void>};
    createCloudflareGitAuth?(options: Cloudflare & Target & {write: true; openAuthorization(url: string): void}): GitAuthProvider;
    composeRepositorySeed(project: ReadonlyMap<string, Uint8Array>, metadata: {
        title: string; description: string; language: 'ja' | 'en'; license?: {name: string; text: string};
    }, toolchainVersion: string): ReadonlyMap<string, Uint8Array>;
    prepareInitialRepository(options: DiskRepository & {files: readonly SeedFile[]; author: Author; timestamp: number}): Promise<{oid: string}>;
    pushInitialRepository(options: DiskRepository & {oid: string; getWriteGrant(): Promise<WriteGrant | null>}): Promise<{oid: string}>;
    /** The sb3-toolchain version the seed records; creation is unavailable without it. */
    sb3ToolchainVersion: string | null | undefined;
    /** The licenses a new repository can start with. */
    licenses?: readonly {id: string; text: string}[];
}

type CreationWindow = Window & {showDirectoryPicker?(options: {id: string; mode: 'readwrite'}):
    Promise<FileSystemDirectoryHandle>};

function reserveAuthorization(view: Window) {
    const popup = view.open('about:blank', '_blank');
    if (!popup) throw creationError('popupBlocked');
    popup.opener = null;
    return {
        open(url: string) {
            if (popup.closed) throw creationError('denied');
            popup.location.replace(url);
        },
        close: () => popup.close(),
        closed: () => popup.closed
    };
}

function delay(view: Window, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const stop = () => {view.clearTimeout(timer); reject(signal.reason);};
        const timer = view.setTimeout(() => {signal.removeEventListener('abort', stop); resolve();}, 1500);
        signal.addEventListener('abort', stop, {once: true});
        if (signal.aborted) stop();
    });
}

function desktopProvider(bridge: DesktopRepositoryCreation, services: ProjectRepositoryHostServices) {
    let client: Promise<CreationClient> | undefined;
    let interaction: CreationInteraction;
    const getClient = () => client ??= bridge.getConnection().then(connection => services.createRepositoryClient({
        connection,
        async authorize(signal) {
            const existing = await bridge.getGrant();
            signal?.throwIfAborted();
            if (existing) return existing;
            const abort = () => {void bridge.disconnect().catch(() => {});};
            signal?.addEventListener('abort', abort, {once: true});
            try {
                const code = await bridge.begin();
                signal?.throwIfAborted();
                if (code.verificationUri !== 'https://github.com/login/device' || !/^[A-Za-z0-9-]{4,20}$/u.test(code.userCode) ||
                    !Number.isFinite(code.expiresAt) || code.expiresAt <= Date.now()) throw creationError('denied');
                interaction.deviceCode(code);
                const grant = await bridge.finish();
                signal?.throwIfAborted();
                return grant;
            } finally {
                signal?.removeEventListener('abort', abort);
            }
        }
    })).catch(error => {client = undefined; throw error;});
    return {
        mode: 'desktop',
        connect(controls) {
            interaction = controls;
            return getClient().then(creation => creation.connectForCreation(controls.signal));
        },
        async create(session, intent, signal) {return (await getClient()).createRepository(session, intent, signal);},
        async topics(session, repository, signal) {return (await getClient()).setRepositoryTopics(session, repository, signal);},
        async inspect(_session, operationId) {
            if (bridge.inspectCreation) return bridge.inspectCreation(operationId);
            return {status: 'unknown', candidate: await bridge.inspectUnknown(operationId)};
        },
        adopt: (_session, intent, id) => bridge.adoptUnknown(intent.operationId, id)
    } satisfies RepositoryCreationProvider<Session>;
}

function cloudflareProvider(view: Window, {bffOrigin}: Cloudflare, services: ProjectRepositoryHostServices) {
    let popup: ReturnType<typeof reserveAuthorization> | undefined;
    let session: Session | null = null;
    const auth = services.createCloudflareRepositoryAuth!({bffOrigin, openAuthorization: url => popup!.open(url)});
    const client = services.createRepositoryClient({connection: auth.connection, authorize: auth.authorize});
    return {
        mode: 'cloudflare',
        async connect({signal}) {
            signal.throwIfAborted();
            if (session && session.expiresAt > Date.now()) return session;
            if (popup) throw creationError('denied');
            popup = reserveAuthorization(view);
            try {
                session = await client.connectForCreation(signal);
                return session;
            } catch (error) {
                void auth.disconnect().catch(() => {});
                throw error;
            } finally {
                popup.close();
                popup = undefined;
            }
        },
        create: client.createRepository,
        topics: client.setRepositoryTopics,
        async inspect(session, operationId, signal) {
            if (client.inspectCreation) return client.inspectCreation(session, operationId, signal);
            return {status: 'unknown', candidate: await client.inspectUnknown?.(session, operationId, signal) ?? null};
        },
        adopt: client.adoptUnknown
    } satisfies RepositoryCreationProvider<Session>;
}

export function bindProjectRepositoryCreation({view, desktop, cloudflare, browserFolders, createBrowserFolder, locale, author, prepareSource,
    openProject, services}: {
    /** What the host's build supplies; see `ProjectRepositoryHostServices`. */
    services: ProjectRepositoryHostServices;
    view: CreationWindow;
    /** Puts new repositories in the browser's own storage instead of a picked folder. */
    browserFolders?: BrowserRepositoryFolders;
    /** Makes a new empty folder in the browser's storage, for a working copy the person chose to keep there (#679). */
    createBrowserFolder?: BrowserRepositoryFolders['create'];
    desktop?: DesktopRepositoryCreation;
    cloudflare?: Cloudflare;
    locale: string;
    author(): Promise<Author | undefined>;
    prepareSource(serialize: () => Promise<Uint8Array>, current: () => boolean, title: string): Promise<ReadonlyMap<string, Uint8Array>>;
    openProject(directory: FileSystemDirectoryHandle, root: FileSystemDirectoryHandle): Promise<boolean>;
}) {
    if (!view.indexedDB || !view.navigator.locks || !(browserFolders || view.showDirectoryPicker) || !view.crypto?.subtle ||
        typeof services?.createRepositoryClient !== 'function' || typeof services.composeRepositorySeed !== 'function' ||
        typeof services.prepareInitialRepository !== 'function' || typeof services.pushInitialRepository !== 'function' ||
        typeof services.sb3ToolchainVersion !== 'string') return undefined;
    if (!desktop && (!cloudflare || typeof services.createCloudflareRepositoryAuth !== 'function' ||
        typeof services.createCloudflareGitAuth !== 'function')) return undefined;
    const toolchainVersion = services.sb3ToolchainVersion;
    const provider = desktop ? desktopProvider(desktop, services) : cloudflareProvider(view, cloudflare!, services);
    const licenses = services.licenses ?? [];
    const pickDirectory = async () => {
        if (browserFolders) return browserFolders.choose();
        try {
            return await view.showDirectoryPicker!({id: 'turbowarp-plus-new-git-repository', mode: 'readwrite'});
        } catch (error) {
            if ((error as DOMException).name === 'AbortError') return null;
            throw error;
        }
    };
    const workflow = createProjectRepositoryWorkflow({
        provider,
        journal: repositoryCreationJournal(view.indexedDB),
        exclusive: (id, run) => view.navigator.locks.request('tw-plus-github-create:' + id, run),
        prepare: ({repository, ...input}) => services.prepareInitialRepository({...input,
            remote: repository.remote, repositoryId: repository.id}),
        async startWrite(progress, interaction) {
            const {repository, account, operationId} = progress;
            const {signal} = interaction;
            if (!repository) throw creationError('pendingRepository');
            const {remote, id: repositoryId} = repository;
            if (desktop) {
                const session = await provider.connect(interaction);
                if (session?.account.login.toLowerCase() !== account.toLowerCase()) throw creationError('denied');
                signal.throwIfAborted();
                const grant = await desktop.authorizeInitialPush(operationId, repositoryId);
                if (!grant) return null;
                const revoke = async () => {await desktop.revokeInitialPush?.(operationId, repositoryId, grant.session.bearer);};
                if (signal.aborted) {
                    void revoke().catch(() => {});
                    signal.throwIfAborted();
                }
                return {grant, revoke};
            }
            const popup = reserveAuthorization(view);
            const auth = services.createCloudflareGitAuth!({...cloudflare!, remote, repositoryId, write: true,
                openAuthorization: popup.open});
            const lifetime = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
            let granted = false;
            try {
                await auth.connect(lifetime);
                while (true) {
                    lifetime.throwIfAborted();
                    const session = await auth.getSession();
                    lifetime.throwIfAborted();
                    if (session) {
                        if (session.account.login.toLowerCase() !== account.toLowerCase()) throw creationError('denied');
                        granted = true;
                        return {grant: {remote, repositoryId, session}, revoke: () => auth.disconnect()};
                    }
                    if (popup.closed()) break;
                    if ((await auth.getState()).status !== 'connecting') break;
                    await delay(view, lifetime);
                }
                return null;
            } finally {
                popup.close();
                if (!granted) void auth.disconnect().catch(() => {});
            }
        },
        releaseWrite: ({revoke}) => revoke(),
        async push({repository, grant: {grant}, ...input}) {
            await services.pushInitialRepository({...input, remote: repository.remote, repositoryId: repository.id,
                getWriteGrant: async () => grant});
        },
        openProject,
        pickDirectory
    });
    return {
        ...workflow,
        licenses: licenses.map(({id}) => ({id, label: id})),
        /**
         * `target` is where the working copy goes: `browser` for a new folder in the browser's storage, or an empty
         * folder already picked on the device. Without it, the folder follows where this browser keeps new folders.
         */
        async start(draft: GitHubRepositoryDraft, serialize: () => Promise<Uint8Array>, current: () => boolean, signal: AbortSignal,
            target?: 'browser' | FileSystemDirectoryHandle) {
            const createInBrowser = target === 'browser' || !target && browserFolders ? browserFolders?.create ?? createBrowserFolder : undefined;
            if (target === 'browser' && !createInBrowser) throw creationError('invalidRequest');
            // A folder in the browser is made only once the project is ready, so a cancelled creation leaves none behind.
            const directory = typeof target === 'object' ? target : createInBrowser ? null : await pickDirectory();
            if (!createInBrowser && !directory || !current()) return null;
            if (directory) {
                for await (const _entry of (directory as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values())
                    throw creationError('directoryNotEmpty');
            }
            const project = await prepareSource(serialize, current, draft.title).catch(error => {
                if ((error as DOMException).name === 'AbortError') return null;
                throw error;
            });
            if (!project || !current()) return null;
            const selected = licenses.find(({id}) => id === draft.license);
            if (draft.license && !selected) throw creationError('invalidRequest');
            const seed = services.composeRepositorySeed(project, {title: draft.title, description: draft.description,
                language: locale.startsWith('ja') ? 'ja' : 'en', license: selected && {name: selected.id, text: selected.text}},
            toolchainVersion);
            const identity = await author() ?? {name: draft.account, email: draft.account + '@users.noreply.github.com'};
            if (!current()) return null;
            return workflow.start({directory: directory ?? await createInBrowser!(draft.title), draft, author: identity, files: [...seed].map(([path, bytes]) => ({path, bytes})), signal});
        }
    };
}
