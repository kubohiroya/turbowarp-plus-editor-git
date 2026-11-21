import {defineConfig, esmExternalRequirePlugin} from 'vite';

export default defineConfig({
    resolve: {alias: {buffer: 'buffer/'}},
    build: {
        target: 'es2017',
        // The Editor host minifies the final bundle. Preserve class bindings for webpack 4.
        minify: false,
        license: {fileName: 'THIRD_PARTY_NOTICES.md'},
        lib: {
            entry: {
                index: 'src/browser.ts',
                repository: 'src/repository.ts',
                'task-queue': 'src/task-queue.ts',
                'initial-commit': 'src/initial-commit.ts',
                'smart-http': 'src/smart-http.ts',
                'pull-request-queue': 'src/pull-request-queue.ts',
                'github-publication-host': 'src/github-publication-host.ts',
                'project-source-diff': 'src/project-source-diff.tsx',
                'project-publication': 'src/project-publication.ts',
                'cloudflare-publication': 'src/cloudflare-publication.ts',
                'project-commit-dialog': 'src/project-commit-dialog.ts',
                'project-publication-dialog': 'src/project-publication-dialog.ts',
                'project-repository-creation': 'src/project-repository-creation.ts',
                'remote-repository': 'src/remote-repository-dialog.tsx',
                'project-version-preview': 'src/project-version-preview.ts'
            },
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
            cssFileName: 'style'
        },
        rolldownOptions: {
            // Isomorphic Git's ESM build uses Buffer without importing it.
            transform: {inject: {Buffer: ['buffer/', 'Buffer']}},
            // The bundled JSX runtime must resolve React to the host's copy in ESM builds.
            plugins: [esmExternalRequirePlugin({external: ['react', 'react-dom']})],
            // The dialogs share the host's dialog actions and their stylesheet.
            external: ['@kubohiroya/turbowarp-plus-editor-windows']
        }
    }
});
