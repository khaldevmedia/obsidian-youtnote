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
        rolldownOptions: {
            external: ['obsidian', '@codemirror/state', '@codemirror/view'],
            output: {
                dir: '.',
                entryFileNames: 'main.js',
                assetFileNames: 'styles.css',
                codeSplitting: false
            }
        },
        emptyOutDir: false,
        sourcemap: false,
        minify: true
    }
});