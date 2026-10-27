/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DD_RUM_APPLICATION_ID: string;
  /** Datadog site, e.g. datadoghq.com / datadoghq.eu / us5.datadoghq.com. */
  readonly VITE_DD_SITE: string;
  readonly VITE_OTEL_COLLECTOR_URL: string;
  readonly VITE_OTEL_SERVICE_NAME: string;
  readonly VITE_OTEL_SERVICE_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
