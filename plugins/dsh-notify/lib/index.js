/**
 * Node (Host) half of the `dsh-notify` plugin.
 *
 * The browser half (`./client.js`) raises ordinary desktop notifications through
 * the page's `Notification` API. That API cannot carry buttons: Electron's
 * platform notification service maps a web notification onto its native options
 * without ever forwarding `actions`, so a permission request can only be
 * answered after the user switches back to the DSH window. This half closes that
 * gap on macOS: while an approval is pending and DSH is not the frontmost
 * application, it shows a small non-activating AppKit panel with
 * "Allow once / Reject", and returns the clicked decision to the waiting
 * `approval/request` waterfall — no context switch required.
 *
 * The panel itself lives in `./native/panel.m` and is compiled on demand by
 * `./native/runner.js`. Platform support, configuration, and failure modes all
 * degrade to `next()` (the in-app approval panel), never to a lost request.
 *
 * @module dsh-notify
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

//#region dsh-notify: configuration
/** Default tuning values, also used when a row supplies no config at all. */
const DEFAULTS = {
	/** Whether the native approval panel may replace the in-app prompt at all. */
	approvalPopup: true,
	/** How long one panel stays on screen before it hands the request back to the app. */
	popupTimeoutMs: 180000,
	/** Only interrupt when the DSH window is not the frontmost application. */
	onlyWhenBackground: true,
	/** Subagent sessions are silent by default, matching the browser half. */
	includeSubagents: false,
	/** Bundle identifier that counts as "the user is looking at DSH". */
	frontmostBundleId: "com.deepseek.dsh"
};

/** Inclusive bounds for {@link DEFAULTS.popupTimeoutMs}, so a typo cannot pin a panel forever. */
const POPUP_TIMEOUT_MIN_MS = 10000;
const POPUP_TIMEOUT_MAX_MS = 3600000;

/**
 * Normalize one raw Loader row config into complete, bounded settings.
 * @param raw - config object supplied by `cordis.patch.yml`, or undefined.
 * @returns the effective settings, with every field defaulted and clamped.
 */
function resolveConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const timeout = Number(source.popupTimeoutMs);
	return {
		approvalPopup: typeof source.approvalPopup === "boolean" ? source.approvalPopup : DEFAULTS.approvalPopup,
		popupTimeoutMs: Number.isFinite(timeout) && timeout >= POPUP_TIMEOUT_MIN_MS && timeout <= POPUP_TIMEOUT_MAX_MS ? Math.round(timeout) : DEFAULTS.popupTimeoutMs,
		onlyWhenBackground: typeof source.onlyWhenBackground === "boolean" ? source.onlyWhenBackground : DEFAULTS.onlyWhenBackground,
		includeSubagents: typeof source.includeSubagents === "boolean" ? source.includeSubagents : DEFAULTS.includeSubagents,
		frontmostBundleId: typeof source.frontmostBundleId === "string" && source.frontmostBundleId.trim() !== "" ? source.frontmostBundleId.trim() : DEFAULTS.frontmostBundleId
	};
}
//#endregion

//#region dsh-notify: copy
/** Absolute path of the macOS user-defaults tool used to read the system language. */
const DEFAULTS_TOOL = existsSync("/usr/bin/defaults") ? "/usr/bin/defaults" : "defaults";

/**
 * Decide whether the panel copy should be Chinese.
 *
 * A Finder-launched Host inherits the launchd environment, which carries no
 * `LANG`/`LC_*`; Node's `Intl` then reports `en-US` regardless of the macOS
 * language. The authoritative source is `AppleLanguages`, whose first entry is
 * the preferred system language.
 *
 * @param input - environment and locale evidence, all optional.
 * @returns true when the copy should be Chinese.
 */
function resolveChinese(input) {
	const env = input?.env ?? {};
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) {
		const value = env[key];
		if (typeof value === "string" && /^zh/iu.test(value.trim())) return true;
	}
	const languages = input?.appleLanguages;
	if (typeof languages === "string" && languages.trim() !== "") {
		// `AppleLanguages` is a plist array: ( "zh-Hans-CN", "en-US" ). The first
		// entry decides; a non-Chinese first entry means the UI is not Chinese.
		const first = /["']([^"']+)["']/u.exec(languages)?.[1] ?? languages.trim();
		if (first !== "") return /^zh/iu.test(first);
	}
	const locale = input?.appleLocale;
	if (typeof locale === "string" && locale.trim() !== "") return /^zh/iu.test(locale.trim());
	const intl = input?.intlLocale;
	return typeof intl === "string" && /^zh/iu.test(intl);
}

/** Cached language decision; the system language does not change mid-run. */
let chineseLanguage;

/**
 * Read the macOS system language once.
 * @returns true when the panel copy should be Chinese.
 */
async function isChinese() {
	if (chineseLanguage !== undefined) return chineseLanguage;
	const appleLanguages = await run(DEFAULTS_TOOL, ["read", "-g", "AppleLanguages"], 1500);
	const appleLocale = await run(DEFAULTS_TOOL, ["read", "-g", "AppleLocale"], 1500);
	let intlLocale;
	try {
		intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {}
	chineseLanguage = resolveChinese({ env: process.env, appleLanguages, appleLocale, intlLocale });
	return chineseLanguage;
}

/**
 * Localized labels for the native panel.
 * @param zh - whether the system locale is Chinese.
 * @returns the strings the panel displays.
 */
function copy(zh) {
	return {
		meta: zh ? "DeepSeek Harness · 等待审批" : "DeepSeek Harness · waiting for approval",
		title: (tool) => (zh ? `${tool} 请求提升权限` : `${tool} requests elevated permission`),
		fallbackBody: zh ? "该操作需要你的授权才能继续" : "This action needs your approval to continue",
		allowLabel: zh ? "允许一次" : "Allow once",
		denyLabel: zh ? "拒绝" : "Reject",
		dismissLabel: zh ? "稍后在应用内处理" : "Handle in the app later",
		locale: zh ? "zh" : "en"
	};
}
//#endregion

//#region dsh-notify: frontmost application
/** Absolute path of the macOS application-state tool used to read the frontmost bundle id. */
const LSAPPINFO = existsSync("/usr/bin/lsappinfo") ? "/usr/bin/lsappinfo" : "lsappinfo";

/**
 * Run one short-lived command and resolve its stdout.
 * @param file - executable path.
 * @param args - argument vector, never shell-interpolated.
 * @param timeout - hard limit in milliseconds.
 * @returns stdout, or undefined when the command failed or timed out.
 */
function run(file, args, timeout) {
	return new Promise((resolvePromise) => {
		try {
			execFile(file, args, { timeout, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
				resolvePromise(error !== null && error !== undefined ? undefined : stdout);
			});
		} catch {
			resolvePromise(undefined);
		}
	});
}

/**
 * Extract the bundle id from `lsappinfo info -only bundleid` output.
 * @param output - raw stdout, which also repeats the frontmost application name.
 * @returns the bundle id, or undefined when the output has an unexpected shape.
 */
function parseFrontBundleId(output) {
	if (typeof output !== "string") return undefined;
	const match = /\bbundleID="([^"]+)"/u.exec(output);
	return match === null ? undefined : match[1];
}

/**
 * Read the bundle identifier of the frontmost application.
 * @returns the bundle id, or undefined when macOS would not report one.
 */
async function frontmostBundleId() {
	const front = await run(LSAPPINFO, ["front"], 1500);
	if (typeof front !== "string") return undefined;
	const asn = /\bASN:[^\s]+/u.exec(front);
	if (asn === null) return undefined;
	const info = await run(LSAPPINFO, ["info", "-only", "bundleid", asn[0]], 1500);
	return parseFrontBundleId(info);
}
//#endregion

//#region dsh-notify: approval interception
/**
 * Build a FIFO task runner so two concurrent approvals never stack two panels.
 * @returns a function that queues one task behind the previous task.
 */
function createSerialQueue() {
	let tail = Promise.resolve();
	return (task) => {
		const result = tail.then(task, task);
		tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};
}

/**
 * Map one panel choice onto the approval waterfall vocabulary.
 * @param choice - `runner.prompt()` result.
 * @param aborted - whether the request signal ended the wait first.
 * @returns a final outcome, or undefined when the request must be delegated.
 */
function decideOutcome(choice, aborted) {
	if (aborted) return "cancelled";
	if (choice === "allow") return "allowed-once";
	if (choice === "deny") return "rejected";
	return undefined;
}

/**
 * Shorten a home-relative path for display.
 * @param value - absolute path.
 * @returns the path with the user's home replaced by `~`.
 */
function tilde(value) {
	try {
		const home = homedir();
		if (home !== "" && value.startsWith(home)) return `~${value.slice(home.length)}`;
	} catch {}
	return value;
}

/**
 * Read the label used as the panel subtitle: the agent preset and workspace.
 * @param request - the pending approval request.
 * @returns a short session label, or an empty string when nothing is known.
 */
function workspaceLabel(request) {
	const header = request?.agent?.session?.header;
	const parts = [];
	if (typeof header?.agentPreset === "string" && header.agentPreset !== "") parts.push(header.agentPreset);
	const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
	if (cwd !== undefined && cwd !== "") parts.push(tilde(cwd));
	else if (typeof header?.id === "string") parts.push(header.id);
	return parts.join(" · ");
}

/**
 * Whether one request belongs to a subagent session.
 * @param request - the pending approval request.
 * @returns true for delegated sessions.
 */
function isSubagent(request) {
	const header = request?.agent?.session?.header;
	if (header === undefined || header === null) return false;
	return header.origin === "subagent" || (typeof header.delegationDepth === "number" && header.delegationDepth > 0);
}

/**
 * Create the approval interceptor this plugin registers on the Host waterfall.
 *
 * Every external dependency is injectable so the decision logic stays testable
 * without a Loader, a real panel, or a running macOS application.
 *
 * @param options - settings and injectable platform seams.
 * @returns the waterfall listener plus a disposer that withdraws the active panel.
 */
function createApprovalInterceptor(options) {
	const config = options.config;
	const logger = options.logger;
	const prompt = options.prompt;
	const frontmost = options.frontmost ?? frontmostBundleId;
	const enqueue = createSerialQueue();
	let active = undefined;
	let disposed = false;

	/**
	 * Show one panel and translate its choice, falling back to delegation.
	 * @param request - the pending approval request.
	 * @returns the outcome, or undefined to delegate to the next listener.
	 */
	async function show(request) {
		if (disposed) return undefined;
		const signal = request?.signal;
		if (signal?.aborted) return "cancelled";
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener?.("abort", onAbort, { once: true });
		active = controller;
		let choice;
		try {
			const strings = copy(await isChinese());
			const tool = typeof request?.toolName === "string" && request.toolName !== "" ? request.toolName : "tool";
			const body = typeof request?.reason === "string" && request.reason.trim() !== "" ? request.reason.trim() : strings.fallbackBody;
			choice = await prompt(
				{
					meta: strings.meta,
					title: strings.title(tool),
					subtitle: workspaceLabel(request),
					body,
					allowLabel: strings.allowLabel,
					denyLabel: strings.denyLabel,
					dismissLabel: strings.dismissLabel,
					timeoutMs: config.popupTimeoutMs,
					locale: strings.locale
				},
				{ signal: controller.signal }
			);
		} catch (error) {
			logger?.warn?.("[dsh-notify] approval panel failed; falling back to the in-app prompt:", error);
			choice = "unavailable";
		} finally {
			if (active === controller) active = undefined;
			signal?.removeEventListener?.("abort", onAbort);
		}
		const outcome = decideOutcome(choice, signal?.aborted === true);
		if (outcome !== undefined) {
			logger?.info?.(`[dsh-notify] approval panel answered: ${outcome}`);
			return outcome;
		}
		if (choice !== "unavailable") logger?.info?.(`[dsh-notify] approval panel closed (${String(choice)}); delegating to the in-app prompt`);
		return undefined;
	}

	/**
	 * Host `approval/request` waterfall listener.
	 * @param request - Agent-scoped approval request.
	 * @param next - delegates to the following listener, normally the browser panel.
	 * @returns the closed approval outcome.
	 */
	async function handle(request, next) {
		try {
			if (disposed || !config.approvalPopup) return next();
			if (!config.includeSubagents && isSubagent(request)) return next();
			if (config.onlyWhenBackground) {
				const front = await frontmost();
				// An unreadable frontmost app is treated as background: the whole
				// point of the panel is to reach the user while DSH is hidden.
				if (front !== undefined && front === config.frontmostBundleId) return next();
			}
			const outcome = await enqueue(() => show(request));
			if (outcome === undefined) return next();
			return outcome;
		} catch (error) {
			options.logger?.warn?.("[dsh-notify] approval interception failed; delegating:", error);
			return next();
		}
	}

	/** Withdraw the active panel (and any queued work) when the plugin unloads. */
	function dispose() {
		disposed = true;
		active?.abort();
		active = undefined;
	}

	return { handle, dispose };
}
//#endregion

//#region dsh-notify: plugin
/**
 * Load the native panel runner lazily.
 *
 * A missing or broken native module must never keep the rest of the plugin from
 * mounting: it only means this Host half delegates every approval to the app.
 *
 * @returns the module, or undefined when it cannot be loaded.
 */
async function loadRunner() {
	try {
		return await import("./native/runner.js");
	} catch (error) {
		return undefined;
	}
}

/**
 * Mount the Host half.
 *
 * @param ctx - Host plugin context.
 * @param rawConfig - Loader row config; every field is optional.
 */
function apply(ctx, rawConfig) {
	if (process.platform !== "darwin") {
		// Only macOS can host the non-activating AppKit panel; elsewhere the
		// browser half keeps raising its ordinary notification.
		return;
	}
	const config = resolveConfig(rawConfig);
	let interceptor;
	const prompt = async (request, promptOptions) => {
		const runner = await loadRunner();
		if (runner === undefined || runner.PLATFORM_SUPPORTED !== true) return "unavailable";
		return runner.prompt(request, promptOptions);
	};
	interceptor = createApprovalInterceptor({
		config,
		logger: ctx.logger,
		prompt
	});
	try {
		ctx.effect(() => () => interceptor.dispose(), "dsh-notify: approval panel lifetime");
	} catch {}
	try {
		// Prepend so the panel can decide before the browser waterfall forwards
		// the request into the page; `next()` keeps the in-app panel intact.
		ctx.on("approval/request", (request, next) => interceptor.handle(request, next), { prepend: true });
	} catch (error) {
		ctx.logger?.warn?.("[dsh-notify] could not register the approval interceptor; approvals stay in-app:", error);
	}
}

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-notify";
//#endregion

export { apply, createApprovalInterceptor, createSerialQueue, decideOutcome, name, parseFrontBundleId, resolveChinese, resolveConfig, DEFAULTS };
