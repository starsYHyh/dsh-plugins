window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region dsh-notify: settings and copy
		/** localStorage / sessionStorage key prefix for every replaceable setting. */
		const STORAGE_PREFIX = "dshNotify.";

		/**
		 * Read one boolean tuning flag from localStorage.
		 * @param key - suffix after {@link STORAGE_PREFIX}.
		 * @param fallback - value used when the key is absent or unreadable.
		 * @returns the parsed flag.
		 */
		function readFlag(key, fallback) {
			try {
				const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key);
				if (raw === undefined || raw === null || raw === "") return fallback;
				return raw !== "0" && raw !== "false";
			} catch {
				return fallback;
			}
		}

		/**
		 * Read one numeric tuning flag from localStorage inside a closed range.
		 * @param key - suffix after {@link STORAGE_PREFIX}.
		 * @param fallback - value used when the key is absent, unreadable, or out of range.
		 * @param min - inclusive lower bound.
		 * @param max - inclusive upper bound.
		 * @returns the parsed duration in milliseconds.
		 */
		function readNumber(key, fallback, min, max) {
			try {
				const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key);
				if (raw === undefined || raw === null || raw.trim() === "") return fallback;
				const value = Number(raw);
				if (!Number.isFinite(value) || value < min || value > max) return fallback;
				return value;
			} catch {
				return fallback;
			}
		}

		/**
		 * Read every tuning flag, so one notification never mixes settings generations.
		 * @returns the effective settings.
		 */
		function readSettings() {
			return {
				enabled: readFlag("enabled", true),
				greet: readFlag("greet", true),
				silent: readFlag("silent", false),
				always: readFlag("always", false),
				subagents: readFlag("subagents", false),
				settleMs: readNumber("settleMs", 1500, 0, 10000)
			};
		}

		/** Whether the GUI locale is Chinese, so notification copy follows the application language. */
		function isChinese() {
			const lang = globalThis.document?.documentElement?.lang || globalThis.navigator?.language || "en";
			return String(lang).toLowerCase().startsWith("zh");
		}

		/**
		 * Notification copy in the current GUI language.
		 * @returns localized strings and the approval body builder.
		 */
		function copy() {
			const zh = isChinese();
			return {
				greetTitle: zh ? "通知已开启" : "Notifications on",
				greetBody: zh ? "会话完成或需要你确认时，我会通知你" : "I will notify you when a session finishes or needs you",
				done: zh ? "回合已完成，可以回来查看了" : "Turn finished — come back to review",
				input: zh ? "需要你的输入" : "Waiting for your input",
				approval: (tool) => (zh ? `需要你批准工具调用：${tool}` : `Approval needed: ${tool}`),
				testBody: zh ? "这是一条测试通知" : "This is a test notification"
			};
		}
		//#endregion

		//#region dsh-notify: notification delivery
		/** Whether a human is plausibly looking at this page right now. */
		function isLookingAtPage() {
			const doc = globalThis.document;
			if (doc === undefined || doc === null) return false;
			if (doc.visibilityState === "hidden") return false;
			return typeof doc.hasFocus === "function" ? doc.hasFocus() === true : true;
		}

		/**
		 * Raise one native notification through the page's own Notification API.
		 * @param title - notification title, normally the session display title.
		 * @param body - notification body.
		 * @param options - `tag` replaces a previous banner, `silent` suppresses the system sound.
		 * @returns the notification, or undefined when the platform cannot deliver one.
		 */
		function deliver(title, body, options) {
			const NotificationApi = globalThis.Notification;
			if (typeof NotificationApi !== "function") {
				console.warn("[dsh-notify] this page has no Notification API; nothing was shown");
				return undefined;
			}
			if (NotificationApi.permission === "denied") {
				console.warn("[dsh-notify] notification permission is denied for this application");
				return undefined;
			}
			if (NotificationApi.permission === "default") {
				try {
					NotificationApi.requestPermission().catch(() => {});
				} catch {}
				return undefined;
			}
			let notification;
			try {
				notification = new NotificationApi(title, {
					body,
					tag: options?.tag ?? "dsh-notify",
					silent: options?.silent === true
				});
			} catch (error) {
				console.warn("[dsh-notify] the platform refused the notification:", error);
				return undefined;
			}
			notification.onclick = () => {
				try {
					globalThis.focus();
				} catch {}
				try {
					notification.close();
				} catch {}
			};
			return notification;
		}
		//#endregion

		//#region dsh-notify: browser plugin
		/**
		* Notify the user when a session finishes a turn or blocks on a human.
		*
		* Turn boundaries are read from the session-status projection that
		* `@deepseek-ai/dsh-client-ui-session` already maintains for the sidebar, so
		* this plugin adds no polling and no second source of truth. A finished turn
		* waits one settle window before it notifies, which collapses the
		* intermediate idle gap of a multi-round goal into a single notification.
		*
		* Settings live in localStorage under the `dshNotify.` prefix:
		* `enabled`, `greet`, `silent`, `always`, `subagents`, `settleMs`.
		* `__dshNotify.test()` raises one notification on demand from the console.
		*
		* @param ctx - browser application context.
		*/
		function apply(ctx) {
			try {
				ctx.inject(["uiSession"], install);
			} catch (error) {
				console.error("[dsh-notify] could not mount; the DSH client plugin API may have changed:", error);
			}
		}

		/**
		* Install the notification projection once `uiSession` exists.
		*
		* Every DSH-owned shape this plugin depends on is validated once here, and
		* the projection reader is wrapped, so an API change after an application
		* update degrades into one loud diagnostic plus `shapeOk: false` in the
		* console self-check instead of a silent no-op or a failed plugin entry.
		*
		* @param scope - injected client context (carries `uiSession`, `sessions`, `effect`).
		*/
		function install(scope) {
			const status = scope.uiSession?.sessionStatus;
			if (status === undefined || status === null || typeof status.subscribe !== "function" || typeof status.getSnapshot !== "function") {
				console.warn("[dsh-notify] uiSession.sessionStatus is missing or changed shape; notifications stay off. Adapt plugins/dsh-notify/lib/client.js to the current DSH client API.");
				return;
			}
			/** Post-update diagnostics surfaced through `__dshNotify.state()`. */
			const diagnostics = {
				shapeOk: true,
				notifications: 0,
				lastReason: undefined,
				lastNotifiedAt: undefined
			};
			/** Last observed running state per session. */
			const running = new Map();
			/** Last observed pending interaction object per session. */
			const interactions = new Map();
			/** Pending settle timers per session. */
			const timers = new Map();
			/** Whether the initial projection has been recorded without notifying. */
			let seeded = false;

			/**
			 * Look up one session's list row, the only place a display title exists.
			 * @param sessionId - session identity.
			 * @returns the row, or undefined while the list has not published it.
			 */
			function rowOf(sessionId) {
				const sessions = scope.get("sessions");
				if (sessions === undefined || sessions === null) return undefined;
				return sessions.list?.getSnapshot()?.byId?.[sessionId];
			}

			/**
			 * Whether one session should reach the user at all.
			 * @param row - session list row, when published.
			 * @returns true when the row is an ordinary root session, or when subagent notifications are enabled.
			 */
			function admits(row) {
				if (row === undefined) return false;
				if (readSettings().subagents) return true;
				if (row.origin === "subagent") return false;
				return row.parentId === undefined;
			}

			/**
			 * Raise one notification for a session event, honoring focus, enablement, and session kind.
			 * @param sessionId - session identity.
			 * @param kind - finished turn, pending approval, or pending question.
			 * @param detail - tool name for an approval.
			 * @param force - bypass the focus gate, used by the greeting and the console test.
			 */
			function notify(sessionId, kind, detail, force) {
				const settings = readSettings();
				if (!settings.enabled) return;
				if (force !== true && settings.always !== true && isLookingAtPage()) return;
				const row = rowOf(sessionId);
				if (!admits(row)) return;
				const strings = copy();
				const title = row.displayTitle || row.title || sessionId;
				const body = kind === "approval" ? strings.approval(detail) : kind === "input" ? strings.input : strings.done;
				const delivered = deliver(title, body, {
					tag: `dsh-notify:${sessionId}`,
					silent: settings.silent
				});
				if (delivered !== undefined) {
					diagnostics.notifications += 1;
					diagnostics.lastReason = kind;
					diagnostics.lastNotifiedAt = Date.now();
				}
			}

			/**
			 * Settle one finished turn: notify only when the session is still idle and still unblocked.
			 * @param sessionId - session identity.
			 */
			function scheduleSettled(sessionId) {
				const settings = readSettings();
				const previous = timers.get(sessionId);
				if (previous !== undefined) globalThis.clearTimeout(previous);
				if (settings.settleMs === 0) {
					timers.delete(sessionId);
					settle(sessionId);
					return;
				}
				const handle = globalThis.setTimeout(() => {
					timers.delete(sessionId);
					settle(sessionId);
				}, settings.settleMs);
				timers.set(sessionId, handle);
			}

			/**
			 * Notify for one settled idle session unless it started running again.
			 * @param sessionId - session identity.
			 */
			function settle(sessionId) {
				if (running.get(sessionId) === true) return;
				const interaction = interactions.get(sessionId);
				if (interaction !== undefined && interaction !== null) return;
				notify(sessionId, "done");
			}

			/** Record one status projection change and notify for the interesting transitions. */
			function evaluate() {
				const snapshot = status.getSnapshot();
				if (snapshot === undefined || snapshot === null || typeof snapshot.forEach !== "function") {
					if (diagnostics.shapeOk) {
						diagnostics.shapeOk = false;
						console.warn("[dsh-notify] the session status projection changed shape; notifications stay off. Adapt plugins/dsh-notify/lib/client.js to the current DSH client API.");
					}
					return;
				}
				try {
					applySnapshot(snapshot);
				} catch (error) {
					if (diagnostics.shapeOk) {
						diagnostics.shapeOk = false;
						console.warn("[dsh-notify] reading the session status projection failed; notifications stay off:", error);
					}
				}
			}

			/**
			 * Fold one status snapshot into per-session state and notify for real transitions.
			 * @param snapshot - `Map<sessionId, {running, pendingInteraction}>`.
			 */
			function applySnapshot(snapshot) {
				const present = new Set();
				for (const [sessionId, entry] of snapshot) {
					present.add(sessionId);
					const isRunning = entry.running === true;
					const interaction = entry.pendingInteraction;
					const knownRunning = running.get(sessionId);
					const knownInteraction = interactions.get(sessionId);
					running.set(sessionId, isRunning);
					interactions.set(sessionId, interaction ?? undefined);
					if (!seeded) continue;
					if (interaction !== undefined && interaction !== null && interaction !== knownInteraction) {
						const handle = timers.get(sessionId);
						if (handle !== undefined) {
							globalThis.clearTimeout(handle);
							timers.delete(sessionId);
						}
						notify(sessionId, typeof interaction.toolName === "string" ? "approval" : "input", interaction.toolName);
						continue;
					}
					if (isRunning) {
						const handle = timers.get(sessionId);
						if (handle !== undefined) {
							globalThis.clearTimeout(handle);
							timers.delete(sessionId);
						}
						continue;
					}
					if (knownRunning === true) scheduleSettled(sessionId);
				}
				for (const sessionId of [...running.keys()]) {
					if (present.has(sessionId)) continue;
					running.delete(sessionId);
					interactions.delete(sessionId);
					const handle = timers.get(sessionId);
					if (handle !== undefined) {
						globalThis.clearTimeout(handle);
						timers.delete(sessionId);
					}
				}
				seeded = true;
			}

			scope.effect(() => {
				const unsubscribe = status.subscribe(evaluate);
				evaluate();
				/** Console entry point: prove delivery and inspect what the plugin currently sees. */
				const api = {
					test: () => {
						const strings = copy();
						const [first] = status.getSnapshot().keys();
						const row = first === undefined ? undefined : rowOf(first);
						deliver(row?.displayTitle || row?.title || "DeepSeek Harness", strings.testBody, {
							tag: "dsh-notify:test",
							silent: readSettings().silent
						});
					},
					state: () => ({
						shapeOk: diagnostics.shapeOk,
						notifications: diagnostics.notifications,
						lastReason: diagnostics.lastReason,
						lastNotifiedAt: diagnostics.lastNotifiedAt,
						seeded,
						settings: readSettings(),
						running: Object.fromEntries(running),
						pending: [...interactions.keys()]
					}),
					settings: readSettings
				};
				globalThis.__dshNotify = api;
				if (readSettings().greet) {
					try {
						if (globalThis.sessionStorage?.getItem(STORAGE_PREFIX + "greeted") !== "1") {
							globalThis.sessionStorage?.setItem(STORAGE_PREFIX + "greeted", "1");
							const strings = copy();
							deliver(strings.greetTitle, strings.greetBody, {
								tag: "dsh-notify:greet",
								silent: readSettings().silent
							});
						}
					} catch {}
				}
				console.info("[dsh-notify] ready — settings:", readSettings());
				return () => {
					unsubscribe();
					for (const handle of timers.values()) globalThis.clearTimeout(handle);
					timers.clear();
					if (globalThis.__dshNotify === api) delete globalThis.__dshNotify;
				};
				}, "dsh-notify: session notifications");
		}

		/** Cordis service the projection lives on; `sessions` is read opportunistically for titles. */
		const inject = ["uiSession"];

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-notify";
		return module.exports;
	}
});
