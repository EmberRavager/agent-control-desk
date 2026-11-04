const { contextBridge, ipcRenderer } = require("electron");
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    const message =
      typeof error?.message === "string" ? error.message : String(error);
    throw new Error(
      message.replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        "",
      ),
    );
  }
}
contextBridge.exposeInMainWorld("acd", {
  getNoticeStatus: () => invoke("acd:notice-status"),
  testNotice: () => invoke("acd:notice-test"),
  openNoticeSettings: () => invoke("acd:notice-settings"),
  subscribeNotices: (callback) => {
    let active = true;
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("acd:notice-open", listener);
    invoke("acd:notice-target")
      .then((target) => {
        if (active && target) callback(target);
      })
      .catch(() => {});
    return () => {
      active = false;
      ipcRenderer.removeListener("acd:notice-open", listener);
    };
  },
  getLocalInfo: () => invoke("acd:local-info"),
  openDataDirectory: () => invoke("acd:data-folder"),
  request: (method, path, body) => invoke("acd:request", method, path, body),
  revealSkill: (id) => invoke("acd:skill-folder", id),
  pickExecutable: () => invoke("acd:executable"),
  pickDirectory: () => invoke("acd:directory"),
  subscribe: (onState, onConnection, onError) => {
    const state = (_event, value) => onState(value);
    const connection = (_event, value) => onConnection(value);
    const error = (_event, value) => onError(value);
    ipcRenderer.on("acd:state", state);
    ipcRenderer.on("acd:connection", connection);
    ipcRenderer.on("acd:error", error);
    ipcRenderer.send("acd:subscribe");
    return () => {
      ipcRenderer.removeListener("acd:state", state);
      ipcRenderer.removeListener("acd:connection", connection);
      ipcRenderer.removeListener("acd:error", error);
    };
  },
});
