export interface SadaVoxDesktopBridge {
  isDesktop: boolean;
  platform: string;
  getInfo: () => Promise<{
    isDesktop: boolean;
    platform: string;
    outputDir: string;
    appVersion: string;
  }>;
  openOutputsFolder: () => Promise<{ ok: boolean; error?: string }>;
  saveFileAs: (
    urlPath: string,
    defaultName: string
  ) => Promise<{ saved: boolean; cancelled?: boolean; filePath?: string }>;
  getPathForFile?: (file: File) => string;
}

declare global {
  interface Window {
    sadavoxDesktop?: SadaVoxDesktopBridge;
  }
}

export {};
