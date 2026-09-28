declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;

/** Version stamp of the web bundle itself (see web/vite.config.ts). */
export const WEB_BUILD = { version: __APP_VERSION__, commit: __APP_COMMIT__, builtAt: __APP_BUILT__ };
