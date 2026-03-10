import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    define: {
        'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
        lib: {
            entry: path.resolve(__dirname, 'src/main.ts'),
            name: 'main',
            formats: ['cjs']
        },
        rollupOptions: {
            external: ['obsidian'],
            output: {
                dir: '.',
                entryFileNames: 'main.js',
                assetFileNames: 'styles.css',
                inlineDynamicImports: true
            }
        },
        emptyOutDir: false,
        sourcemap: false,
        minify: true
    }
});