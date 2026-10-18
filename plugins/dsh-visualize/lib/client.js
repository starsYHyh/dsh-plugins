/**
 * dsh-visualize — client half.
 *
 * Finds inline-visualization content references in rendered assistant text
 * (U+E200 visualize U+E202 {json} U+E201) and replaces each one with a
 * sandboxed iframe served by the host half. Every viewer carries a top-right
 * overflow menu with "复制图像" (copy image), backed by a PNG export bridge
 * inside the iframe.
 *
 * No React import: this plugin is a plain DOM observer, materialized by the
 * web client module loader and disposed through its Cordis effect.
 */
window.__ModuleLoader__.load({
  id: "dsh-visualize",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Content-reference markers (Unicode private-use area). */
    var MARK_START = "\uE200";
    var TOKEN_RE = /\uE200visualize\uE202(\{[\s\S]*?\})\uE201/g;

    /** Viewer attributes used for idempotent scanning and height routing. */
    var VIEWER_CLASS = "dsh-visualize-frame";
    var SHELL_CLASS = "dsh-visualize-shell";
    var TOOLBAR_CLASS = "dsh-visualize-toolbar";
    var TRIGGER_CLASS = "dsh-visualize-trigger";
    var MENU_CLASS = "dsh-visualize-menu";
    var ITEM_CLASS = "dsh-visualize-menu-item";
    var STATUS_CLASS = "dsh-visualize-status";
    var VIEWER_ATTR = "data-dsh-visualize";
    var VIEWER_ID_ATTR = "data-viewer-id";
    var READY_ATTR = "data-ready";
    var HEIGHT_ATTR = "data-height";
    var MIN_HEIGHT = 80;
    var MAX_HEIGHT = 4000;
    var DEFAULT_HEIGHT = 320;
    var EXPORT_TIMEOUT = 8000;

    /** Theme custom properties copied from the host page into the viewer. */
    var THEME_VARS = [
      "--dsw-alias-bg-base",
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-layer-3",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-border-l2",
      "--dsw-alias-brand-primary",
      "--dsw-alias-button-primary-fill",
      "--dsw-alias-label-primary-inverted",
      "--dsw-alias-link",
      "--dsw-alias-markdown-code-block",
    ];

    /** Runtime viewer styles injected once into the host document. */
    var VIEWER_CSS = [
      "." + SHELL_CLASS + " { position: relative; margin: 10px 0; }",
      "." + VIEWER_CLASS + " {",
      "  display: block;",
      "  width: 100%;",
      "  max-width: 100%;",
      "  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));",
      "  border-radius: 12px;",
      "  background: transparent;",
      "  color-scheme: light dark;",
      "}",
      "." + TOOLBAR_CLASS + " { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; }",
      "." + TRIGGER_CLASS + " {",
      "  width: 24px; height: 24px; padding: 0;",
      "  display: grid; place-items: center;",
      "  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));",
      "  border-radius: 7px;",
      "  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.92));",
      "  color: var(--dsw-alias-label-secondary, #5d6268);",
      "  cursor: pointer;",
      "  opacity: 0.68;",
      "  transition: opacity 0.12s ease;",
      "}",
      "." + TRIGGER_CLASS + " svg { display: block; fill: currentColor; }",
      "." + SHELL_CLASS + ":hover ." + TRIGGER_CLASS + ",",
      "." + TOOLBAR_CLASS + ".is-open ." + TRIGGER_CLASS + ",",
      "." + TRIGGER_CLASS + ":focus-visible { opacity: 1; }",
      "." + MENU_CLASS + " {",
      "  position: absolute; top: 29px; right: 0;",
      "  min-width: 118px; padding: 4px;",
      "  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));",
      "  border-radius: 8px;",
      "  background: var(--dsw-alias-bg-layer-1, #ffffff);",
      "  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);",
      "}",
      "." + MENU_CLASS + "[hidden] { display: none; }",
      "." + ITEM_CLASS + " {",
      "  display: block; width: 100%;",
      "  padding: 6px 10px;",
      "  border: 0; border-radius: 5px;",
      "  background: transparent;",
      "  color: var(--dsw-alias-label-primary, #1b1b1c);",
      "  font: inherit; font-size: 12px; text-align: left;",
      "  cursor: pointer; white-space: nowrap;",
      "}",
      "." + ITEM_CLASS + ":hover { background: var(--dsw-alias-bg-layer-2, #f2f2f3); }",
      "." + ITEM_CLASS + ":disabled { opacity: 0.65; cursor: default; }",
      "." + STATUS_CLASS + " {",
      "  position: absolute; top: 36px; right: 8px; z-index: 6;",
      "  padding: 3px 8px; border-radius: 6px;",
      "  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));",
      "  background: var(--dsw-alias-bg-layer-1, #ffffff);",
      "  color: var(--dsw-alias-label-secondary, #5d6268);",
      "  font: 11px/1.5 inherit;",
      "  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);",
      "  pointer-events: none;",
      "}",
      "." + STATUS_CLASS + "[hidden] { display: none; }",
    ].join("\n");

    var viewerSeq = 0;
    var exportSeq = 0;
    var scanTimer = 0;
    var installed = false;
    var pendingExports = Object.create(null);
    var debugEnabled = false;
    try {
      debugEnabled = new URLSearchParams(window.location.search).get("dshVisualizeDebug") === "1";
    } catch (error) {
      debugEnabled = false;
    }

    /** Append one diagnostic line when the debug URL parameter is present. */
    function debugLog(message) {
      if (!debugEnabled || !document.body) return;
      var element = document.getElementById("dsh-visualize-debug");
      if (!element) {
        element = document.createElement("div");
        element.id = "dsh-visualize-debug";
        element.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:6px 8px;border-radius:6px;background:#111;color:#fff;font:11px/1.4 monospace;max-width:80vw;white-space:pre-wrap;";
        document.body.appendChild(element);
      }
      element.textContent += (element.textContent ? " | " : "") + message;
    }

    /** Resolve one color token to a concrete rgb() value, or "" when unset. */
    function resolveColorVar(name) {
      var probe = document.createElement("span");
      probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
      probe.style.color = "var(" + name + ", rgb(1, 2, 3))";
      document.body.appendChild(probe);
      var resolved = "";
      try {
        resolved = window.getComputedStyle(probe).color;
      } catch (error) {
        resolved = "";
      }
      probe.remove();
      if (!resolved || resolved === "rgb(1, 2, 3)" || resolved === "rgba(0, 0, 0, 0)") return "";
      return resolved;
    }

    /** Read the current theme from the host page body. */
    function readTheme() {
      var vars = {};
      var style = null;
      try {
        style = window.getComputedStyle(document.body);
      } catch (error) {
        style = null;
      }
      var colorVars = [
        "--dsw-alias-button-primary-fill",
        "--dsw-alias-brand-primary",
        "--dsw-alias-label-primary-inverted",
      ];
      for (var index = 0; index < THEME_VARS.length; index++) {
        var name = THEME_VARS[index];
        if (colorVars.indexOf(name) !== -1) {
          var resolved = resolveColorVar(name);
          if (resolved) {
            vars[name] = resolved;
            continue;
          }
        }
        var value = style ? style.getPropertyValue(name) : "";
        if (value && value.trim()) vars[name] = value.trim();
      }
      var dark = false;
      try {
        dark =
          document.body.hasAttribute("data-ds-dark-theme") ||
          document.documentElement.hasAttribute("data-ds-dark-theme");
      } catch (error) {
        dark = false;
      }
      return { vars: vars, scheme: dark ? "dark" : "light" };
    }

    /** UTF-8 safe base64 for the theme query parameter. */
    function toBase64(text) {
      var bytes = new TextEncoder().encode(text);
      var binary = "";
      for (var index = 0; index < bytes.length; index++) {
        binary += String.fromCharCode(bytes[index]);
      }
      return window.btoa(binary);
    }

    /** CSS attribute-selector escaping for a viewer id. */
    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
      return String(value).replace(/["\\]/g, "\\$&");
    }

    /** Write one PNG data URL to the clipboard; resolve false when unavailable. */
    function writeClipboard(dataUrl) {
      if (!navigator.clipboard || typeof window.ClipboardItem !== "function") {
        return Promise.resolve(false);
      }
      return fetch(dataUrl)
        .then(function (response) {
          return response.blob();
        })
        .then(function (blob) {
          return navigator.clipboard
            .write([new window.ClipboardItem({ "image/png": blob })])
            .then(function () {
              return true;
            })
            .catch(function () {
              return false;
            });
        })
        .catch(function () {
          return false;
        });
    }

    /** Fallback when the clipboard API is unavailable: download the PNG. */
    function downloadImage(dataUrl) {
      var link = document.createElement("a");
      link.href = dataUrl;
      link.download = "visualization.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    /** Show transient feedback beside one viewer. */
    function showStatus(status, text, transient) {
      if (!status) return;
      window.clearTimeout(status.__hideTimer);
      status.hidden = false;
      status.textContent = text;
      if (transient) {
        status.__hideTimer = window.setTimeout(function () {
          status.hidden = true;
          status.textContent = "";
        }, 2200);
      }
    }

    /** Ask the iframe for a PNG and copy it to the clipboard. */
    function copyViewer(frame, item, status) {
      if (item.disabled) return;
      debugLog("copy:start");
      closeMenus(null);
      var requestId = "x" + (++exportSeq).toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      item.disabled = true;
      showStatus(status, "正在生成…", false);
      var timer = window.setTimeout(function () {
        var pending = pendingExports[requestId];
        if (!pending) return;
        delete pendingExports[requestId];
        pending.item.disabled = false;
        showStatus(pending.status, "复制失败，请重试", true);
      }, EXPORT_TIMEOUT);
      pendingExports[requestId] = { item: item, status: status, timer: timer };
      try {
        frame.contentWindow.postMessage({ type: "dsh-visualize:export", requestId: requestId }, "*");
      } catch (error) {
        window.clearTimeout(timer);
        delete pendingExports[requestId];
        item.disabled = false;
        showStatus(status, "复制失败", true);
      }
    }

    /** Apply an export result that arrived from one viewer. */
    function handleExportResult(data) {
      var pending = pendingExports[data.requestId];
      if (!pending) return;
      delete pendingExports[data.requestId];
      window.clearTimeout(pending.timer);
      var item = pending.item;
      debugLog("copy:result " + (data.error ? "error:" + data.error : "bytes:" + data.dataUrl.length));
      if (typeof data.dataUrl !== "string" || data.error) {
        item.disabled = false;
        showStatus(pending.status, "复制失败", true);
        return;
      }
      writeClipboard(data.dataUrl).then(function (copied) {
        debugLog("copy:clipboard " + copied);
        item.disabled = false;
        showStatus(pending.status, copied ? "已复制" : "已下载", true);
        if (!copied) downloadImage(data.dataUrl);
      });
    }

    /** Build one sandboxed viewer shell with its overflow menu. */
    function createViewer(payload) {
      var shell = document.createElement("div");
      shell.className = SHELL_CLASS;
      shell.setAttribute(VIEWER_ATTR, "");

      var frame = document.createElement("iframe");
      frame.className = VIEWER_CLASS;
      var viewerId = "v" + (++viewerSeq).toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      frame.setAttribute(VIEWER_ID_ATTR, viewerId);
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("loading", "lazy");
      var title =
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim().slice(0, 200)
          : "Inline visualization";
      frame.setAttribute("title", title);

      var theme = readTheme();
      var params = new URLSearchParams();
      params.set("path", payload.path);
      params.set("id", viewerId);
      params.set("scheme", theme.scheme);
      params.set("title", title);
      params.set("vars", toBase64(JSON.stringify(theme.vars)));
      frame.src = "/dsh-visualize/view?" + params.toString();
      frame.style.height = DEFAULT_HEIGHT + "px";
      shell.appendChild(frame);

      var toolbar = document.createElement("div");
      toolbar.className = TOOLBAR_CLASS;

      var trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = TRIGGER_CLASS;
      trigger.setAttribute("aria-label", "可视化操作");
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
        '<circle cx="3" cy="8" r="1.4"></circle>' +
        '<circle cx="8" cy="8" r="1.4"></circle>' +
        '<circle cx="13" cy="8" r="1.4"></circle>' +
        "</svg>";

      var menu = document.createElement("div");
      menu.className = MENU_CLASS;
      menu.setAttribute("role", "menu");
      menu.hidden = true;

      var copyItem = document.createElement("button");
      copyItem.type = "button";
      copyItem.className = ITEM_CLASS;
      copyItem.setAttribute("role", "menuitem");
      copyItem.textContent = "复制图像";
      menu.appendChild(copyItem);

      toolbar.appendChild(trigger);
      toolbar.appendChild(menu);
      shell.appendChild(toolbar);

      var status = document.createElement("div");
      status.className = STATUS_CLASS;
      status.hidden = true;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      shell.appendChild(status);

      trigger.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        debugLog("trigger:click");
        var open = menu.hidden;
        menu.hidden = !open;
        toolbar.classList.toggle("is-open", open);
        trigger.setAttribute("aria-expanded", String(open));
      });
      copyItem.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        debugLog("copyItem:click");
        copyViewer(frame, copyItem, status);
      });

      return shell;
    }

    /** True for text nodes we must never rewrite. */
    function isSkipped(node) {
      var element = node.parentElement;
      if (!element || !element.closest) return true;
      return Boolean(
        element.closest(
          "[data-dsh-visualize], pre, code, input, textarea, select, [contenteditable=''], [contenteditable='true']",
        ),
      );
    }

    /** Replace the content reference inside one text node with a viewer. */
    function replaceTextNode(node) {
      var text = node.nodeValue || "";
      TOKEN_RE.lastIndex = 0;
      var match = TOKEN_RE.exec(text);
      if (!match) return false;
      var payload;
      try {
        payload = JSON.parse(match[1]);
      } catch (error) {
        return false;
      }
      if (!payload || typeof payload.path !== "string" || payload.path.trim() === "") return false;

      var viewer = createViewer(payload);
      var before = text.slice(0, match.index);
      var after = text.slice(match.index + match[0].length);
      var fragment = document.createDocumentFragment();
      if (before) fragment.appendChild(document.createTextNode(before));
      fragment.appendChild(viewer);
      if (after) fragment.appendChild(document.createTextNode(after));
      if (!node.parentNode) return false;
      node.parentNode.replaceChild(fragment, node);
      return true;
    }

    /** First pass: references that live inside a single text node. */
    function scanTextNodes() {
      if (!document.body) return;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      var node = walker.nextNode();
      while (node) {
        if ((node.nodeValue || "").indexOf(MARK_START) !== -1 && !isSkipped(node)) nodes.push(node);
        node = walker.nextNode();
      }
      for (var index = 0; index < nodes.length; index++) {
        if (nodes[index].parentNode) replaceTextNode(nodes[index]);
      }
    }

    /** Second pass: references split across inline nodes by the markdown renderer. */
    function scanSplitBlocks() {
      if (!document.body) return;
      var blocks = document.querySelectorAll("p, li, td, th, h1, h2, h3, div");
      for (var index = 0; index < blocks.length; index++) {
        var element = blocks[index];
        if (element.querySelector && element.querySelector("[data-dsh-visualize], iframe")) continue;
        var text = element.textContent || "";
        if (text.indexOf(MARK_START) === -1) continue;
        if (element.closest && element.closest("[data-dsh-visualize], pre, code, input, textarea, select, [contenteditable]")) continue;
        TOKEN_RE.lastIndex = 0;
        var match = TOKEN_RE.exec(text);
        if (!match || text.trim() !== match[0].trim()) continue;
        var payload;
        try {
          payload = JSON.parse(match[1]);
        } catch (error) {
          continue;
        }
        if (!payload || typeof payload.path !== "string" || payload.path.trim() === "") continue;
        if (!element.parentNode) continue;
        element.parentNode.replaceChild(createViewer(payload), element);
      }
    }

    /** One full scan; both passes are idempotent. */
    function scan() {
      scanTextNodes();
      scanSplitBlocks();
    }

    /** Coalesce mutation bursts into one scan. */
    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = window.setTimeout(function () {
        scanTimer = 0;
        scan();
      }, 80);
    }

    /** Close every open overflow menu. */
    function closeMenus(event) {
      var toolbars = document.querySelectorAll("." + TOOLBAR_CLASS + ".is-open");
      for (var index = 0; index < toolbars.length; index++) {
        var toolbar = toolbars[index];
        if (event && event.target && toolbar.contains(event.target)) continue;
        debugLog("menu:close via " + (event && event.target && event.target.tagName ? event.target.tagName : "api"));
        toolbar.classList.remove("is-open");
        var menu = toolbar.querySelector("." + MENU_CLASS);
        if (menu) menu.hidden = true;
        var trigger = toolbar.querySelector("." + TRIGGER_CLASS);
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      }
    }

    /** Escape closes the menu. */
    function onKeydown(event) {
      if (event.key === "Escape") closeMenus(null);
    }

    /** Apply a height report from a viewer. */
    function onMessage(event) {
      var data = event && event.data;
      if (!data) return;

      if (data.type === "dsh-visualize:height") {
        if (typeof data.id !== "string" || typeof data.height !== "number" || !isFinite(data.height)) return;
        var selector = "iframe[" + VIEWER_ID_ATTR + "='" + cssEscape(data.id) + "']";
        var frame = document.querySelector(selector);
        if (!frame) return;
        var height = Math.round(data.height);
        if (height < MIN_HEIGHT) height = MIN_HEIGHT;
        if (height > MAX_HEIGHT) height = MAX_HEIGHT;
        frame.style.height = height + "px";
        frame.setAttribute(READY_ATTR, "1");
        frame.setAttribute(HEIGHT_ATTR, String(height));
        return;
      }

      if (data.type === "dsh-visualize:export-result") {
        handleExportResult(data);
      }
    }

    /** Optional end-to-end self test driven by a URL query parameter. */
    function runSelftest() {
      var params = new URLSearchParams(window.location.search);
      var path = params.get("dshVisualizeSelftest");
      if (!path) return;
      var status = document.createElement("div");
      status.id = "dsh-visualize-selftest";
      status.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#1b1c1e;color:#fff;font:12px/1.4 monospace;";
      status.textContent = "visualize selftest: starting";
      document.body.appendChild(status);
      var viewer = createViewer({ path: path, title: "selftest" });
      viewer.style.width = "360px";
      document.body.appendChild(viewer);
      viewer.querySelector("iframe").addEventListener("load", function () {
        status.textContent = "visualize selftest: iframe loaded";
      });
      var tries = 0;
      var timer = window.setInterval(function () {
        tries++;
        var frame = viewer.querySelector("iframe");
        var height = frame ? frame.getAttribute(HEIGHT_ATTR) : null;
        if (height) {
          status.textContent = "visualize selftest: ok height=" + height;
          window.clearInterval(timer);
        } else if (tries > 50) {
          status.textContent = "visualize selftest: timeout (no height message)";
          window.clearInterval(timer);
        }
      }, 200);
    }

    /** Install the observer; returns an idempotent disposer. */
    function install() {
      if (installed) return function () {};
      installed = true;

      var style = document.createElement("style");
      style.setAttribute("data-dsh-visualize-style", "");
      style.textContent = VIEWER_CSS;
      document.head.appendChild(style);

      var observer = new MutationObserver(function () {
        scheduleScan();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.addEventListener("message", onMessage);
      document.addEventListener("click", closeMenus, false);
      document.addEventListener("keydown", onKeydown, false);
      scheduleScan();
      runSelftest();

      return function () {
        installed = false;
        observer.disconnect();
        window.removeEventListener("message", onMessage);
        document.removeEventListener("click", closeMenus, false);
        document.removeEventListener("keydown", onKeydown, false);
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }

    exports.apply = function (ctx) {
      var dispose = install();
      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () {
          return dispose;
        }, "dsh-visualize: inline viewer");
      } else {
        return dispose;
      }
    };
    exports.inject = [];
    exports.name = "dsh-visualize";
    return module.exports;
  }
});
