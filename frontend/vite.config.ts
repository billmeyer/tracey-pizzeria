import {defineConfig, loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The repo's shared .env (see ../.env.example) lives one level up from this
// project and holds DD_RUM_APPLICATION_ID unprefixed, while the code reads
// VITE_DD_RUM_APPLICATION_ID. Mirror that mapping here so a bare `npm run dev`
// picks it up even without the Makefile's `make run-frontend` wrapper.
export default defineConfig(({mode}) => {
    const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, '..'), '');

    return {
        plugins: [react()],

        // Multi-page app, not a single-page app. The four funnel steps are four
        // real HTML documents, so navigating between them is a genuine browser
        // unload/load — which is the entire point: each step then reports its
        // own navigation timing, Core Web Vitals and resource timings to RUM
        // instead of inheriting the first document's forever.
        //
        // `appType: 'mpa'` turns off Vite's dev-server SPA fallback, so a typo'd
        // path 404s rather than silently serving the order page — which would
        // turn a bad URL into a wrong-but-plausible page view in RUM.
        appType: 'mpa',

        build: {
            // Ship readable JS. This is a teaching build: attendees open DevTools
            // and read the instrumentation as it runs, and unminified output keeps
            // function names intact so RUM error stack traces name real frames
            // (`promoteNamedAction`, `hardNavigate`) instead of `t`/`e`.
            minify: false,

            rollupOptions: {
                input: {
                    order: path.resolve(import.meta.dirname, 'index.html'),
                    checkout: path.resolve(import.meta.dirname, 'checkout/index.html'),
                    payment: path.resolve(import.meta.dirname, 'payment/index.html'),
                    tracking: path.resolve(import.meta.dirname, 'tracking/index.html'),
                },
            },
        },

        server: {
            allowedHosts: true,
            proxy: {
                '/api': 'http://localhost:4000',
            },
        },

        define: {
            'import.meta.env.VITE_DD_RUM_APPLICATION_ID': JSON.stringify(
                process.env.VITE_DD_RUM_APPLICATION_ID || rootEnv.DD_RUM_APPLICATION_ID || ''
            ),

            // Same unprefixed-root-env mapping as above. Drives the footer's
            // deep link into the RUM session explorer, so the link follows
            // whichever org the collector is exporting to
            // (`otlp.${DD_SITE}`) instead of being pinned to US1.
            'import.meta.env.VITE_DD_SITE': JSON.stringify(
                process.env.VITE_DD_SITE || rootEnv.DD_SITE || ''
            ),
        },
    };
});
