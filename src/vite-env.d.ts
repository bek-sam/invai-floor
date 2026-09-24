/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AUTO_LOCK_MINUTES?: string;
  readonly VITE_DEMO?: string;
}
