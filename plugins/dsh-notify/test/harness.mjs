/**
 * Standalone harness for lib/client.js: emulates the browser module loader, the
 * `uiSession` status projection, `sessions` list, localStorage and the
 * Notification API, then drives turn/interaction transitions and asserts what
 * the user would have seen.
 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function createEnvironment(options = {}) {
	const shown = [];
	const permission = options.permission ?? "granted";
	class FakeNotification {
		static permission = permission;
		static requestPermission() {
			return Promise.resolve(permission);
		}
		constructor(title, config) {
			this.title = title;
			this.body = config?.body;
			this.tag = config?.tag;
			this.silent = config?.silent;
			this.options = config ?? {};
			this.closed = false;
			shown.push(this);
		}
		close() {
			this.closed = true;
		}
	}
	const storage = new Map();
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		Notification: FakeNotification,
		localStorage: {
			getItem: (key) => (storage.has(`l:${key}`) ? storage.get(`l:${key}`) : null),
			setItem: (key, value) => storage.set(`l:${key}`, String(value))
		},
		sessionStorage: {
			getItem: (key) => (storage.has(`s:${key}`) ? storage.get(`s:${key}`) : null),
			setItem: (key, value) => storage.set(`s:${key}`, String(value))
		},
		document: {
			documentElement: { lang: options.lang ?? "zh-CN" },
			visibilityState: options.hidden === true ? "hidden" : "visible",
			hasFocus: () => options.focused !== false
		},
		navigator: { language: options.lang ?? "zh-CN" },
		focus() {
			sandbox.__focused = true;
		}
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	const factories = new Map();
	sandbox.__ModuleLoader__ = {
		load({ id, factory }) {
			factories.set(id, factory);
		}
	};
	vm.runInNewContext(source, sandbox, { filename: "client.js" });
	const factory = factories.get("dsh-notify");
	assert.ok(factory, "the bundle registers the package id");
	const module = factory(() => {
		throw new Error("the bundle must not require anything");
	});

	const statusListeners = new Set();
	const status = {
		snapshot: new Map(),
		getSnapshot() {
			return status.snapshot;
		},
		subscribe(listener) {
			statusListeners.add(listener);
			return () => statusListeners.delete(listener);
		},
		publish(next) {
			status.snapshot = next;
			for (const listener of [...statusListeners]) listener();
		},
		publishRaw(value) {
			status.snapshot = value;
			for (const listener of [...statusListeners]) listener();
		}
	};
	const rows = { byId: {} };
	const sessions = { list: { getSnapshot: () => rows } };
	const disposers = [];
	const scope = {
		uiSession: options.uiSession === "missing" ? {} : { sessionStatus: status },
		get(name) {
			return name === "sessions" ? sessions : undefined;
		},
		effect(callback) {
			disposers.push(callback());
		}
	};
	const injected = [];
	const ctx = {
		inject(names, callback) {
			injected.push(names);
			if (options.injectThrows === true) throw new Error("simulated DSH client API change");
			callback(scope);
		}
	};
	module.apply(ctx);
	return {
		module,
		shown,
		status,
		rows,
		scope,
		sandbox,
		injected,
		dispose() {
			for (const dispose of disposers) dispose();
			disposers.length = 0;
		}
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shorten the settle window so a finished turn is observed within a test tick. */
const fast = (env) => env.sandbox.localStorage.setItem("dshNotify.settleMs", "20");

// 1. A turn that was already running when the page loaded notifies once it ends.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	assert.equal(JSON.stringify(env.injected), JSON.stringify([["uiSession"]]));
	env.rows.byId.s1 = { id: "s1", displayTitle: "默认工作区", running: true };
	env.status.publish(new Map([["s1", { running: true, pendingInteraction: undefined }]]));
	assert.equal(env.shown.length, 1, "the greeting is the only banner so far");
	assert.equal(env.shown[0].tag, "dsh-notify:greet");
	assert.equal(env.shown[0].options.requireInteraction, undefined, "the greeting never requires interaction");
	env.status.publish(new Map([["s1", { running: false, pendingInteraction: undefined }]]));
	assert.equal(env.shown.length, 1, "a finished turn waits for the settle window");
	await sleep(60);
	assert.equal(env.shown.length, 2);
	assert.equal(env.shown[1].title, "默认工作区");
	assert.equal(env.shown[1].body, "回合已完成，可以回来查看了");
	assert.equal(env.shown[1].tag, "dsh-notify:s1");
	assert.equal(env.shown[1].silent, false);
	assert.notEqual(env.shown[1].options.requireInteraction, true, "a finished turn is not a blocking notification");
	assert.equal(env.shown[1].options.requireInteraction, undefined, "done omits requireInteraction entirely");
	env.dispose();
}

// 2. A focused page records the transition without banner spam.
{
	const env = createEnvironment({ focused: true });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work", running: true };
	env.status.publish(new Map([["s1", { running: true }]]));
	const before = env.shown.length;
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(60);
	assert.equal(env.shown.length, before, "a focused page stays quiet");
	assert.equal(env.sandbox.__dshNotify.state().running.s1, false);
	env.dispose();
}

// 3. A pending approval notifies immediately, and a fresh interaction notifies again.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work", running: false };
	env.status.publish(new Map([["s1", { running: false }]]));
	const before = env.shown.length;
	const approval = { sessionId: "s1", toolName: "bash" };
	env.status.publish(new Map([["s1", { running: false, pendingInteraction: approval }]]));
	assert.equal(env.shown.length, before + 1);
	assert.equal(env.shown.at(-1).body, "需要你批准工具调用：bash");
	assert.equal(env.shown.at(-1).options.requireInteraction, true, "a pending approval stays on screen by default");
	env.status.publish(new Map([["s1", { running: false, pendingInteraction: { sessionId: "s1" } }]]));
	assert.equal(env.shown.at(-1).body, "需要你的输入");
	assert.equal(env.shown.at(-1).options.requireInteraction, true, "a pending question stays on screen by default");
	env.dispose();
}

// 4. An idle flicker between goal rounds collapses into one notification.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Goal run", running: true };
	env.status.publish(new Map([["s1", { running: true }]]));
	const before = env.shown.length;
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(10);
	env.status.publish(new Map([["s1", { running: true }]]));
	await sleep(80);
	assert.equal(env.shown.length, before, "a resumed session never notified");
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(60);
	assert.equal(env.shown.length, before + 1);
	env.dispose();
}

// 5. Subagent sessions stay quiet by default and speak when enabled.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	env.rows.byId.child = { id: "child", displayTitle: "Researcher", running: true, origin: "subagent", parentId: "s1" };
	env.status.publish(new Map([["child", { running: true }]]));
	const before = env.shown.length;
	env.status.publish(new Map([["child", { running: false }]]));
	await sleep(60);
	assert.equal(env.shown.length, before, "subagent turns are silent by default");
	env.sandbox.localStorage.setItem("dshNotify.subagents", "1");
	env.status.publish(new Map([["child", { running: true }]]));
	env.status.publish(new Map([["child", { running: false }]]));
	await sleep(60);
	assert.equal(env.shown.length, before + 1);
	assert.equal(env.shown.at(-1).title, "Researcher");
	env.dispose();
}

// 6. The console test bypasses the focus gate, and disposal removes every trace.
{
	const env = createEnvironment({ focused: true });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work" };
	env.status.publish(new Map([["s1", { running: false }]]));
	const before = env.shown.length;
	env.sandbox.__dshNotify.test();
	assert.equal(env.shown.length, before + 1);
	assert.equal(env.shown.at(-1).body, "这是一条测试通知");
	assert.equal(env.shown.at(-1).options.requireInteraction, undefined, "the console test never requires interaction");
	env.dispose();
	assert.equal(env.sandbox.__dshNotify, undefined);
}

// 7. English copy follows a non-Chinese GUI locale.
{
	const env = createEnvironment({ focused: false, lang: "en-US" });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work", running: true };
	env.status.publish(new Map([["s1", { running: true }]]));
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(60);
	assert.equal(env.shown.at(-1).body, "Turn finished — come back to review");
	env.dispose();
}

// 8. A changed DSH client API degrades into a diagnostic, never a thrown fiber error.
{
	const env = createEnvironment({ focused: false, uiSession: "missing" });
	assert.equal(env.sandbox.__dshNotify, undefined);
	env.dispose();
}
{
	const env = createEnvironment({ focused: false, injectThrows: true });
	assert.equal(env.sandbox.__dshNotify, undefined);
	env.dispose();
}

// 9. A malformed projection is reported once and stops reading.
{
	const env = createEnvironment({ focused: false });
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work" };
	env.status.publish(new Map([["s1", { running: true }]]));
	env.status.publishRaw({ not: "a map" });
	assert.equal(env.sandbox.__dshNotify.state().shapeOk, false);
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(60);
	env.dispose();
}

// 10. The self-check reports delivery counters after an update.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work", running: true };
	env.status.publish(new Map([["s1", { running: true }]]));
	env.status.publish(new Map([["s1", { running: false }]]));
	await sleep(60);
	const state = env.sandbox.__dshNotify.state();
	assert.equal(state.shapeOk, true);
	assert.equal(state.notifications, 1);
	assert.equal(state.lastReason, "done");
	assert.ok(state.lastNotifiedAt > 0);
	assert.equal(state.settings.longLived, true, "the default keeps blocking notifications long-lived");
	env.dispose();
}

// 11. `dshNotify.longLived=0` stops the blocking notifications from requiring interaction.
{
	const env = createEnvironment({ focused: false });
	fast(env);
	env.sandbox.localStorage.setItem("dshNotify.longLived", "0");
	assert.equal(env.sandbox.__dshNotify.state().settings.longLived, false);
	env.rows.byId.s1 = { id: "s1", displayTitle: "Work", running: false };
	env.status.publish(new Map([["s1", { running: false }]]));
	env.status.publish(new Map([["s1", { running: false, pendingInteraction: { sessionId: "s1", toolName: "bash" } }]]));
	assert.equal(env.shown.at(-1).body, "需要你批准工具调用：bash");
	assert.notEqual(env.shown.at(-1).options.requireInteraction, true, "longLived=0 disables requireInteraction");
	assert.equal(env.shown.at(-1).options.requireInteraction, undefined);
	env.dispose();
}

console.log("dsh-notify client harness: all checks passed");
