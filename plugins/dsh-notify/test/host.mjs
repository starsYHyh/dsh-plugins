/**
 * Standalone harness for lib/index.js: the Host half of dsh-notify.
 *
 * The interesting behavior is a decision tree over configuration, the macOS
 * frontmost application, the pending request, and the native panel's answer, so
 * every platform seam is injected here. No Loader, no AppKit, and no real
 * process is started; `runner.prompt` is replaced with a scripted stub.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	createApprovalInterceptor,
	createSerialQueue,
	decideOutcome,
	parseFrontBundleId,
	resolveChinese,
	resolveConfig
} from "../lib/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build one pending-approval request shaped like the Host waterfall payload. */
function request(overrides = {}) {
	return {
		agent: { session: { header: { id: "session-1", cwd: join(homedir(), "work/dsh-dev"), agentPreset: "standard" } } },
		toolName: "bash",
		reason: "escalate sandbox to danger-full-access: 安装插件到 profile",
		...overrides
	};
}

/**
 * Build an interceptor with every platform seam scripted.
 * @param overrides - config, prompt behavior, frontmost bundle id.
 * @returns the interceptor plus recorded calls.
 */
function harness(overrides = {}) {
	const calls = { prompt: [], frontmost: 0, next: 0, logged: [] };
	let nextValue = "unavailable";
	const interceptor = createApprovalInterceptor({
		config: resolveConfig(overrides.config ?? {}),
		logger: {
			info: (message) => calls.logged.push(["info", String(message)]),
			warn: (message) => calls.logged.push(["warn", String(message)])
		},
		frontmost: overrides.frontmost ?? (async () => {
			calls.frontmost += 1;
			return overrides.frontBundle ?? "com.google.Chrome";
		}),
		prompt: overrides.prompt ?? (async (panelRequest, options) => {
			calls.prompt.push({ request: panelRequest, options });
			return overrides.choice ?? "allow";
		})
	});
	const next = async () => {
		calls.next += 1;
		return nextValue;
	};
	return {
		interceptor,
		calls,
		next,
		setNext: (value) => {
			nextValue = value;
		}
	};
}

// 1. Configuration: defaults, bounds, and type coercion.
{
	assert.deepEqual(resolveConfig(undefined), {
		approvalPopup: true,
		popupTimeoutMs: 180000,
		onlyWhenBackground: true,
		includeSubagents: false,
		frontmostBundleId: "com.deepseek.dsh"
	});
	assert.deepEqual(resolveConfig({}), resolveConfig(undefined), "an empty row keeps the defaults");
	assert.equal(resolveConfig({ popupTimeoutMs: 5000 }).popupTimeoutMs, 180000, "too small is rejected");
	assert.equal(resolveConfig({ popupTimeoutMs: 99999999 }).popupTimeoutMs, 180000, "too large is rejected");
	assert.equal(resolveConfig({ popupTimeoutMs: "60000" }).popupTimeoutMs, 60000, "numeric strings are accepted");
	assert.equal(resolveConfig({ popupTimeoutMs: 10000 }).popupTimeoutMs, 10000, "the lower bound is inclusive");
	assert.equal(resolveConfig({ popupTimeoutMs: 3600000 }).popupTimeoutMs, 3600000, "the upper bound is inclusive");
	assert.equal(resolveConfig({ approvalPopup: false }).approvalPopup, false);
	assert.equal(resolveConfig({ onlyWhenBackground: false }).onlyWhenBackground, false);
	assert.equal(resolveConfig({ includeSubagents: true }).includeSubagents, true);
	assert.equal(resolveConfig({ frontmostBundleId: "  com.example.app  " }).frontmostBundleId, "com.example.app");
	assert.equal(resolveConfig({ frontmostBundleId: "   " }).frontmostBundleId, "com.deepseek.dsh");
	assert.equal(resolveConfig("nonsense").popupTimeoutMs, 180000, "a non-object row is ignored");
}

// 1b. Panel copy follows the macOS language even when the Host has no LANG.
{
	const zhLanguages = '(\n    "zh-Hans-CN",\n    "en-US"\n)';
	assert.equal(resolveChinese({ env: {}, appleLanguages: zhLanguages, appleLocale: "zh_CN", intlLocale: "en-US" }), true,
		"AppleLanguages carries the system language a Finder-launched Host lacks in LANG");
	assert.equal(resolveChinese({ env: { LANG: "zh_CN.UTF-8" }, appleLanguages: '(\n    "en-US"\n)' }), true,
		"an explicit Chinese LANG still wins");
	assert.equal(resolveChinese({ env: {}, appleLanguages: '(\n    "en-US"\n)', appleLocale: "en_US", intlLocale: "en-US" }), false);
	assert.equal(resolveChinese({ env: {}, appleLanguages: zhLanguages, appleLocale: "en_US", intlLocale: "en-US" }), true,
		"the first AppleLanguages entry decides");
	assert.equal(resolveChinese({ env: {}, appleLocale: "zh_CN", intlLocale: "en-US" }), true);
	assert.equal(resolveChinese({ env: {}, intlLocale: "zh-CN" }), true);
	assert.equal(resolveChinese({ env: {}, intlLocale: "en-US" }), false);
	assert.equal(resolveChinese(undefined), false);
}

// 2. Frontmost parsing tolerates every shape `lsappinfo` can print.
{
	const chrome = `[ NULL ]  ASN:0x0-0x37037: (in front) \n    bundleID="com.google.Chrome"\n`;
	assert.equal(parseFrontBundleId(chrome), "com.google.Chrome");
	assert.equal(parseFrontBundleId(`ASN:0x0-0x1f11f1: \n    bundleID="com.deepseek.dsh"`), "com.deepseek.dsh");
	assert.equal(parseFrontBundleId(`[ NULL ]  ASN:0x0-0x37037: (in front) \n    bundleID=[ NULL ]`), undefined);
	assert.equal(parseFrontBundleId(""), undefined);
	assert.equal(parseFrontBundleId(undefined), undefined);
	assert.equal(parseFrontBundleId("{ not output }"), undefined);
}

// 3. Choice mapping, including the abort precedence.
{
	assert.equal(decideOutcome("allow", false), "allowed-once");
	assert.equal(decideOutcome("deny", false), "rejected");
	assert.equal(decideOutcome("dismiss", false), undefined);
	assert.equal(decideOutcome("timeout", false), undefined);
	assert.equal(decideOutcome("unavailable", false), undefined);
	assert.equal(decideOutcome("allow", true), "cancelled", "an aborted request never grants a late permission");
	assert.equal(decideOutcome("dismiss", true), "cancelled");
}

// 4. The serial queue keeps FIFO order and survives a rejected task.
{
	const order = [];
	const enqueue = createSerialQueue();
	const first = enqueue(async () => {
		order.push("first:start");
		await sleep(20);
		order.push("first:end");
		return "first";
	});
	const second = enqueue(async () => {
		order.push("second:start");
		return "second";
	});
	assert.equal(await first, "first");
	assert.equal(await second, "second");
	assert.deepEqual(order, ["first:start", "first:end", "second:start"]);

	const rejecting = createSerialQueue();
	const failed = rejecting(async () => {
		throw new Error("boom");
	});
	const recovered = rejecting(async () => "recovered");
	await assert.rejects(failed, /boom/u);
	assert.equal(await recovered, "recovered", "a failed task does not poison the chain");
}

// 5. Disabled configuration delegates without touching macOS.
{
	const { interceptor, calls, next } = harness({ config: { approvalPopup: false } });
	assert.equal(await interceptor.handle(request(), next), "unavailable");
	assert.equal(calls.frontmost, 0, "the frontmost check is skipped when the panel is off");
	assert.equal(calls.prompt.length, 0);
	assert.equal(calls.next, 1);
	interceptor.dispose();
}

// 6. Subagents stay silent, unless the user asked for them.
{
	const silent = harness();
	await silent.interceptor.handle(request({ agent: { session: { header: { id: "sub", cwd: "/tmp/w", origin: "subagent" } } } }), silent.next);
	assert.equal(silent.calls.prompt.length, 0);
	assert.equal(silent.calls.next, 1);
	silent.interceptor.dispose();

	const delegated = harness();
	await delegated.interceptor.handle(request({ agent: { session: { header: { id: "sub", cwd: "/tmp/w", delegationDepth: 2 } } } }), delegated.next);
	assert.equal(delegated.calls.prompt.length, 0, "delegationDepth also marks a subagent");
	delegated.interceptor.dispose();

	const included = harness({ config: { includeSubagents: true } });
	assert.equal(await included.interceptor.handle(request({ agent: { session: { header: { id: "sub", cwd: "/tmp/w", origin: "subagent" } } } }), included.next), "allowed-once");
	assert.equal(included.calls.prompt.length, 1);
	included.interceptor.dispose();
}

// 7. While the user is looking at DSH, the in-app panel keeps the request.
{
	const { interceptor, calls, next } = harness({ frontBundle: "com.deepseek.dsh" });
	assert.equal(await interceptor.handle(request(), next), "unavailable");
	assert.equal(calls.frontmost, 1);
	assert.equal(calls.prompt.length, 0);
	assert.equal(calls.next, 1);
	interceptor.dispose();
}

// 8. While another application is frontmost, the panel decides.
{
	const { interceptor, calls, next } = harness({ choice: "allow" });
	assert.equal(await interceptor.handle(request(), next), "allowed-once");
	assert.equal(calls.prompt.length, 1);
	assert.equal(calls.next, 0);
	const panel = calls.prompt[0].request;
	assert.match(panel.title, /bash/u);
	assert.equal(panel.subtitle, "standard · ~/work/dsh-dev", "the preset and workspace label the request");
	assert.match(panel.body, /escalate sandbox/u);
	assert.equal(panel.timeoutMs, 180000);
	assert.match(panel.meta, /DeepSeek Harness/u);
	assert.ok(["允许一次", "Allow once"].includes(panel.allowLabel));
	assert.ok(["拒绝", "Reject"].includes(panel.denyLabel));
	assert.equal(calls.prompt[0].options.signal instanceof AbortSignal, true, "the panel receives an abort signal");
	interceptor.dispose();

	const denied = harness({ choice: "deny" });
	assert.equal(await denied.interceptor.handle(request(), denied.next), "rejected");
	denied.interceptor.dispose();
}

// 9. Dismissed, timed-out, or unavailable panels hand the request back to the app.
for (const choice of ["dismiss", "timeout", "unavailable"]) {
	const { interceptor, calls, next } = harness({ choice });
	assert.equal(await interceptor.handle(request(), next), "unavailable", `${choice} delegates`);
	assert.equal(calls.prompt.length, 1);
	assert.equal(calls.next, 1);
	interceptor.dispose();
}

// 10. A failing panel is contained and delegates.
{
	const { interceptor, calls, next } = harness({
		prompt: async () => {
			throw new Error("panel crashed");
		}
	});
	assert.equal(await interceptor.handle(request(), next), "unavailable");
	assert.equal(calls.next, 1);
	assert.ok(calls.logged.some(([level, message]) => level === "warn" && message.includes("approval panel failed")));
	interceptor.dispose();
}

// 11. An abort withdraws the panel and never grants a late permission.
{
	let panelSignal;
	const controller = new AbortController();
	const { interceptor, calls, next } = harness({
		prompt: async (_panel, options) => {
			panelSignal = options.signal;
			await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
			return "dismiss";
		}
	});
	const pending = interceptor.handle(request({ signal: controller.signal }), next);
	await sleep(20);
	assert.equal(panelSignal.aborted, false);
	controller.abort();
	assert.equal(await pending, "cancelled");
	assert.equal(calls.next, 0, "the request is already cancelled; nothing is delegated");
	interceptor.dispose();
}

// 12. Two concurrent approvals never stack two panels.
{
	const order = [];
	const { interceptor, next } = harness({
		prompt: async (panel) => {
			order.push(`show:${panel.body}`);
			await sleep(30);
			order.push(`hide:${panel.body}`);
			return "allow";
		}
	});
	const first = interceptor.handle(request({ reason: "first" }), next);
	const second = interceptor.handle(request({ reason: "second" }), next);
	assert.deepEqual(await Promise.all([first, second]), ["allowed-once", "allowed-once"]);
	assert.deepEqual(order, ["show:first", "hide:first", "show:second", "hide:second"], "the queue serializes the panels");
	interceptor.dispose();
}

// 13. Disposing the plugin withdraws an active panel.
{
	let aborted = false;
	const { interceptor, next } = harness({
		prompt: async (_panel, options) => {
			await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
			aborted = true;
			return "dismiss";
		}
	});
	const pending = interceptor.handle(request(), next);
	await sleep(20);
	interceptor.dispose();
	assert.equal(await pending, "unavailable", "a disposed plugin delegates instead of deciding");
	assert.equal(aborted, true);
	// Once disposed, later requests go straight to the app.
	assert.equal(await interceptor.handle(request(), next), "unavailable");
}

// 14. The plugin body wires the waterfall listener only where the panel can exist.
{
	const registered = [];
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		effect: () => {},
		on: (event, listener, options) => {
			registered.push({ event, listener, options });
		}
	};
	const { apply } = await import("../lib/index.js");
	const before = registered.length;
	apply(ctx, { approvalPopup: false });
	const added = registered.slice(before);
	assert.equal(added.length, process.platform === "darwin" ? 1 : 0, "the listener is registered on macOS only");
	if (added.length === 1) {
		assert.equal(added[0].event, "approval/request");
		assert.equal(added[0].options.prepend, true, "the panel runs before the browser forwarding listener");
		let nextCalls = 0;
		const outcome = await added[0].listener(request(), async () => {
			nextCalls += 1;
			return "unavailable";
		});
		assert.equal(outcome, "unavailable");
		assert.equal(nextCalls, 1, "a disabled panel delegates");
	}
}

console.log("dsh-notify host harness: all checks passed");
