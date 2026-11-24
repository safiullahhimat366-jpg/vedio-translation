const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sadavoxDesktop', {
  isDesktop: true,
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('sadavox:get-info'),
  openOutputsFolder: () => ipcRenderer.invoke('sadavox:open-outputs-folder'),
  saveFileAs: (urlPath, defaultName) =>
    ipcRenderer.invoke('sadavox:save-file', { urlPath, defaultName }),
  getPathForFile: (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : '';
    } catch {
      return '';
    }
  },
});
