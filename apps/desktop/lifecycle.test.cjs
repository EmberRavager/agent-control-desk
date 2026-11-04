const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
async function fixture() {
  const handlers = new Map(),
    external = [],
    app = new EventEmitter();
  let visible = true,
    focused = false,
    hidden = 0,
    menu;
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit() {},
    setBadgeCount() {},
  });
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: "" },
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        },
        setWindowOpenHandler() {},
        send() {},
      });
      Object.assign(this, {
        setMenuBarVisibility() {},
        isMinimized: () => false,
        isDestroyed: () => false,
        isVisible: () => visible,
        isFocused: () => focused,
        restore() {},
        show() {
          visible = true;
        },
        focus() {
          focused = true;
        },
        hide() {
          visible = false;
          hidden++;
        },
        loadFile: async () => {},
      });
    }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value) {
      menu = value;
    }
    destroy() {}
  }
  const context = {
    __dirname,
    URL,
    AbortSignal,
    process: { platform: "darwin", env: {} },
    require(name) {
      if (name === "electron")
        return {
          app,
          BrowserWindow: Window,
          Tray,
          Menu: { buildFromTemplate: (value) => value },
          nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
          Notification: { isSupported: () => false },
          ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
          shell: { openExternal: async (url) => external.push(url) },
          dialog: {},
        };
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8") +
      "\nthis.lifecycle={getWindow:()=>window,setBackground:value=>{backgroundEnabled=value;},rendererUrl};",
    context,
  );
  await new Promise((r) => setImmediate(r));
  const window = context.lifecycle.getWindow();
  window.webContents.mainFrame.url = context.lifecycle.rendererUrl;
  return {
    app,
    window,
    handlers,
    external,
    context,
    get hidden() {
      return hidden;
    },
    get visible() {
      return visible;
    },
    get menu() {
      return menu;
    },
  };
}
test("closing a notification-enabled window keeps the desktop reachable through its tray", async () => {
  const x = await fixture();
  let prevented = false;
  x.window.emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(x.hidden, 1);
  x.menu.find((item) => item.label === "打开 ACD").click();
  assert.equal(x.visible, true);
  x.app.emit("before-quit");
  prevented = false;
  x.window.emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
});
test("background opt-out allows closing and OS settings IPC has a fixed trusted destination", async () => {
  const x = await fixture();
  x.context.lifecycle.setBackground(false);
  let prevented = false;
  x.window.emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  const event = {
    sender: x.window.webContents,
    senderFrame: x.window.webContents.mainFrame,
  };
  await x.handlers.get("acd:notice-settings")(event);
  assert.equal(
    x.external[0],
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  );
  await assert.rejects(
    async () =>
      x.handlers.get("acd:notice-settings")({
        ...event,
        senderFrame: { url: "https://untrusted.example" },
      }),
    /拒绝/,
  );
  x.app.emit("before-quit");
});
