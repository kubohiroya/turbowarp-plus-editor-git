import {defineConfig, esmExternalRequirePlugin} from 'vite';

export default defineConfig({
    resolve: {alias: {buffer: 'buffer/'}},
    build: {
        target: 'es2017',
        license: {fileName: 'THIRD_PARTY_NOTICES.md'},
        lib: {
            entry: {index: 'src/browser.ts', repository: 'src/repository.ts'},
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
            cssFileName: 'style'
        },
        rolldownOptions: {
            // The bundled JSX runtime must resolve React to the host's copy in ESM builds.
            plugins: [esmExternalRequirePlugin({external: ['react', 'react-dom']})]
        }
    }
});
