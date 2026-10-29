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
                // The backend is on localhost when the dev server runs on the
                // host (`make run-frontend`) and at `http://backend:4000` under
                // compose, where localhost is the frontend container itself.
                // Env-driven so both paths work unchanged — compose sets
                // VITE_API_PROXY_TARGET, the host path leaves it unset.
                //
                // Read from process.env rather than import.meta.env because it
                // is consumed by the dev server in Node, not by anything
                // shipped to the browser. The proxy is server-side: the browser
                // only ever talks to :5173, which is why the backend's port
                // needs no publishing for the funnel to work.
                '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000',

                // Browser OTLP exports. Same reasoning as /api — localhost on
                // the host path, the compose service name under compose — but
                // this one also exists to make the exports *same-origin*.
                //
                // An OTLP POST can never be a CORS "simple request": its
                // content type is application/json or x-protobuf, neither of
                // which is on the simple-request allowlist. So any cross-origin
                // Collector has to answer a preflight for every export, and a
                // remote viewer's `localhost:4318` would point at their own
                // machine rather than the host running the stack. Proxying
                // sidesteps both.
                //
                // The rewrite strips the prefix, so /otlp/v1/traces reaches the
                // Collector as /v1/traces.
                '/otlp': {
                    target: process.env.VITE_OTLP_PROXY_TARGET || 'http://localhost:4318',
                    rewrite: (path: string) => path.replace(/^\/otlp/, ''),
                },
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
