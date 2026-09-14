const {
  contextBridge,
  ipcRenderer,
} = require("electron");

contextBridge.exposeInMainWorld("syndesk", {
  getState: () => ipcRenderer.invoke("get-state"),
  activate: (options) =>
    ipcRenderer.invoke("activate", options),
  deactivate: () => ipcRenderer.invoke("deactivate"),
  copyText: (value) =>
    ipcRenderer.invoke("copy-text", value),
  injectInput: (payload) =>
    ipcRenderer.invoke("inject-input", payload),
  getDisplaySource: () =>
    ipcRenderer.invoke("get-display-source"),
  windowAction: (action) =>
    ipcRenderer.invoke("window-action", action),
  onDisabled: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(
      "remote-access-disabled",
      listener,
    );
    return () =>
      ipcRenderer.removeListener(
        "remote-access-disabled",
        listener,
      );
  },
  onInputStatus: (callback) => {
    const listener = (_event, ready) =>
      callback(Boolean(ready));
    ipcRenderer.on("input-host-status", listener);
    return () =>
      ipcRenderer.removeListener(
        "input-host-status",
        listener,
      );
  },
});
