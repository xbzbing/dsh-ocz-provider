window.__ModuleLoader__.load({ id: "dsh-opencode2free-provider", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/types.ts
/** The bridge prefix (same-origin, loopback-only on the host). */
const BRIDGE_PREFIX = "/api/oc2dsh/ip-pool";

//#endregion
//#region src/client/bridge-client.ts
/** POST one bridge route and normalize every outcome to a {@link BridgeReply}. */
async function postBridge(route, body = {}, options = {}) {
	const send = options.fetch ?? fetch;
	let response;
	try {
		response = await send(`${BRIDGE_PREFIX}${route}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options.signal
		});
	} catch (err) {
		return {
			ok: false,
			code: options.signal?.aborted === true || err instanceof Error && err.name === "AbortError" ? "client-aborted" : "client-network",
			message: err instanceof Error ? err.message : String(err)
		};
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		return {
			ok: false,
			code: "client-bad-response",
			message: `HTTP ${response.status}`
		};
	}
	if (typeof parsed !== "object" || parsed === null) return {
		ok: false,
		code: "client-bad-response",
		message: `HTTP ${response.status}`
	};
	const record = parsed;
	if (record.ok === true) return {
		ok: true,
		value: record.value
	};
	if (record.ok === false) return {
		ok: false,
		code: typeof record.code === "string" ? record.code : "unknown",
		message: typeof record.message === "string" ? record.message : ""
	};
	const message = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
	return {
		ok: false,
		code: `client-http-${response.status}`,
		message
	};
}
/**
* The text to show for a failed reply: the host's own message when the host
* produced the failure (e.g. `exit-unreachable`), the caller's localized
* fallback for transport-level failures.
*/
function bridgeErrorText(reply, fallback) {
	if (reply.code.startsWith("client-") || reply.message.trim() === "") return fallback;
	return reply.message;
}
/**
* POST /exit. Pins go through here (never a direct settings write) because
* the host probes the listener, relabels a protocol mismatch, refuses an
* unreachable port and revives a dead row before it pins.
*/
function exitAction(action, exitId, options) {
	return postBridge("/exit", action === "pin-local" || action === "unpin" ? { action } : {
		action,
		exitId
	}, options);
}
/** POST /probe. */
function probeAction(scope, options) {
	return postBridge("/probe", scope, options);
}

//#endregion
//#region src/client/icons.tsx
/** Shared drawing frame: 16×16 grid, stroked in the surrounding text colour. */
function Glyph({ children }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		viewBox: "0 0 16 16",
		width: "13",
		height: "13",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.5",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		focusable: "false",
		children
	});
}
/** 固定: a closed padlock — subsequent traffic always uses this exit. */
function PinIcon() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
		x: "3.5",
		y: "7",
		width: "9",
		height: "6.5",
		rx: "1.6"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" })] });
}
/** 取消固定: the same padlock with its shackle lifted. */
function UnpinIcon() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
		x: "3.5",
		y: "7",
		width: "9",
		height: "6.5",
		rx: "1.6"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V6" })] });
}
/** 轮换: a circular arrow — swap in a reserve, or sink to the tail. */
function RotateIcon() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Glyph, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.8 8A4.8 4.8 0 1 1 8 3.2" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.2 1.6 8 3.2 6.2 4.8" })] });
}

//#endregion
//#region src/client/region.ts
/**
* The stats modal's 地区 column: one short region code per exit row instead of
* the full "HK Central" the IP tooltip already carries.
*
* Input is the exit's `exitLocation`, which admission.ts builds as
* `${countryCode} ${city}` from the ip-api echo (`HK Central`, `SG Singapore`,
* `DE Frankfurt am Main`), so the first whitespace-separated token IS the
* ISO-3166-1 alpha-2 country code. The table below widens those codes into the
* region labels — the two anchors are the mapping's own examples (香港 → HK,
* 新加坡 → SGP) — and anything unmapped falls back to the raw alpha-2 code
* rather than a blank, so a new airport location is still readable the day it
* appears.
*
* Deliberately a browser-side module with no host imports (the bundle must
* not drag the YAML parser in), hence the plain object.
*/
/** Country code → the region label shown in the 地区 column. */
const REGION_CODES = {
	HK: "HK",
	TW: "TW",
	MO: "MO",
	CN: "CHN",
	SG: "SGP",
	JP: "JPN",
	KR: "KOR",
	US: "USA",
	CA: "CAN",
	MX: "MEX",
	BR: "BRA",
	AR: "ARG",
	CL: "CHL",
	GB: "GBR",
	IE: "IRL",
	FR: "FRA",
	DE: "DEU",
	NL: "NLD",
	BE: "BEL",
	LU: "LUX",
	CH: "CHE",
	AT: "AUT",
	IT: "ITA",
	ES: "ESP",
	PT: "PRT",
	SE: "SWE",
	NO: "NOR",
	DK: "DNK",
	FI: "FIN",
	IS: "ISL",
	PL: "POL",
	CZ: "CZE",
	SK: "SVK",
	HU: "HUN",
	RO: "ROU",
	BG: "BGR",
	GR: "GRC",
	HR: "HRV",
	SI: "SVN",
	RS: "SRB",
	LT: "LTU",
	LV: "LVA",
	EE: "EST",
	UA: "UKR",
	MD: "MDA",
	RU: "RUS",
	TR: "TUR",
	IL: "ISR",
	AE: "ARE",
	SA: "SAU",
	QA: "QAT",
	KW: "KWT",
	EG: "EGY",
	MA: "MAR",
	ZA: "ZAF",
	NG: "NGA",
	KE: "KEN",
	IN: "IND",
	PK: "PAK",
	BD: "BGD",
	LK: "LKA",
	NP: "NPL",
	MM: "MMR",
	TH: "THA",
	VN: "VNM",
	MY: "MYS",
	ID: "IDN",
	PH: "PHL",
	KH: "KHM",
	MN: "MNG",
	KZ: "KAZ",
	UZ: "UZB",
	AU: "AUS",
	NZ: "NZL"
};
/**
* The 地区 code for one `exitLocation`, or an empty string when the value
* carries no country code at all (an unprobed exit, or a source that reports
* a bare city) — the caller renders its own placeholder for that case.
*/
function regionCode(location) {
	const token = location.trim().split(/\s+/)[0] ?? "";
	if (!/^[A-Za-z]{2}$/.test(token)) return "";
	const code = token.toUpperCase();
	return REGION_CODES[code] ?? code;
}

//#endregion
//#region \0dsh-css:src/client/shared.module.css.mjs
const css$5 = ".bfdUEq_status{color:var(--dsw-alias-label-tertiary,#6b7280);margin:4px 0;font-size:13px;line-height:1.5}.bfdUEq_statusStale{color:var(--dsw-alias-state-warning-primary,#9a6700);margin:4px 0;font-size:12px;line-height:1.5}.bfdUEq_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.bfdUEq_srOnly{clip:rect(0 0 0 0);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.bfdUEq_statsSummary{flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px;display:flex}.bfdUEq_statsChip{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;border-radius:999px;align-items:center;padding:2px 8px;font-size:11px;line-height:18px;display:inline-flex}.bfdUEq_actionGroup{vertical-align:middle;display:inline-flex}.bfdUEq_actionGroup>button+button{margin-left:-1px}.bfdUEq_actionGroup>button:not(:first-child){border-top-left-radius:0;border-bottom-left-radius:0}.bfdUEq_actionGroup>button:not(:last-child){border-top-right-radius:0;border-bottom-right-radius:0}.bfdUEq_actionGroup>button:hover:not(:disabled),.bfdUEq_actionGroup>button:focus-visible{z-index:1;position:relative}";
const tagId$5 = "dsh-opencode2free-provider/shared.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId$5;
	tag.textContent = css$5;
	document.head.appendChild(tag);
}
var shared_module_css_default = {
	"actionGroup": "bfdUEq_actionGroup",
	"mono": "bfdUEq_mono",
	"srOnly": "bfdUEq_srOnly",
	"statsChip": "bfdUEq_statsChip",
	"statsSummary": "bfdUEq_statsSummary",
	"status": "bfdUEq_status",
	"statusStale": "bfdUEq_statusStale"
};

//#endregion
//#region \0dsh-css:src/client/usage-panel.module.css.mjs
const css$4 = ".RtW54a_usagePanel{flex-direction:column;gap:14px;display:flex}.RtW54a_usageScopeChip{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff);font-weight:600}.RtW54a_usageSection{flex-direction:column;gap:6px;display:flex}.RtW54a_usageSectionTitle{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;font-weight:600}.RtW54a_dayChart{align-items:flex-end;gap:8px;margin:0;padding:0;list-style:none;display:flex}.RtW54a_dayColumn{flex-direction:column;flex:1 1 0;align-items:center;gap:4px;min-width:52px;display:flex}.RtW54a_dayTrack{border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);align-items:flex-end;width:24px;height:88px;display:flex}.RtW54a_dayBar{background:var(--dsw-alias-state-business-primary,#4f8cff);border-radius:4px 4px 0 0;width:100%;min-height:2px;display:block}.RtW54a_dayLabel{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px}.RtW54a_dayValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}.RtW54a_usageTabs{margin-bottom:6px}.RtW54a_usageTableWrap{overflow-x:hidden}.RtW54a_usageTable{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px}.RtW54a_usageTable th:first-child{width:40%}.RtW54a_usageTable th:nth-child(2){width:18%}.RtW54a_usageTable th:nth-child(3),.RtW54a_usageTable th:nth-child(4){width:12%}.RtW54a_usageTable th:nth-child(5){width:18%}.RtW54a_usageTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#6b7280);border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);padding:5px 8px;font-weight:600}.RtW54a_usageTable td{border-bottom:1px solid var(--dsw-alias-border-l3,#eaeef2);color:var(--dsw-alias-label-primary,#1f2329);text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;overflow:hidden}.RtW54a_usageTable tbody tr:hover td{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}.RtW54a_sessionLabel,.RtW54a_projectLabel{text-overflow:ellipsis;vertical-align:bottom;max-width:100%;display:inline-block;overflow:hidden}.RtW54a_projectList{flex-direction:column;gap:4px;margin:0;padding:0;font-size:12px;list-style:none;display:flex}.RtW54a_projectRow{align-items:baseline;gap:10px;display:flex}.RtW54a_projectMeta{color:var(--dsw-alias-label-tertiary,#6b7280)}.RtW54a_usageClear{align-items:center;gap:6px;margin-left:auto;display:inline-flex}.RtW54a_usageClearPrompt{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px}.RtW54a_usageClearDanger{border:1px solid var(--dsw-alias-state-error-primary,#d1242f);background:var(--dsw-alias-state-error-primary,#d1242f);color:#fff;cursor:pointer;border-radius:6px;padding:6px 12px;font-size:13px}.RtW54a_usageClearDanger:disabled{opacity:.6;cursor:default}.RtW54a_usageFootnote{color:var(--dsw-alias-label-tertiary,#6b7280);margin:0;font-size:11px}";
const tagId$4 = "dsh-opencode2free-provider/usage-panel.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId$4;
	tag.textContent = css$4;
	document.head.appendChild(tag);
}
var usage_panel_module_css_default = {
	"dayBar": "RtW54a_dayBar",
	"dayChart": "RtW54a_dayChart",
	"dayColumn": "RtW54a_dayColumn",
	"dayLabel": "RtW54a_dayLabel",
	"dayTrack": "RtW54a_dayTrack",
	"dayValue": "RtW54a_dayValue",
	"projectLabel": "RtW54a_projectLabel",
	"projectList": "RtW54a_projectList",
	"projectMeta": "RtW54a_projectMeta",
	"projectRow": "RtW54a_projectRow",
	"sessionLabel": "RtW54a_sessionLabel",
	"usageClear": "RtW54a_usageClear",
	"usageClearDanger": "RtW54a_usageClearDanger",
	"usageClearPrompt": "RtW54a_usageClearPrompt",
	"usageFootnote": "RtW54a_usageFootnote",
	"usagePanel": "RtW54a_usagePanel",
	"usageScopeChip": "RtW54a_usageScopeChip",
	"usageSection": "RtW54a_usageSection",
	"usageSectionTitle": "RtW54a_usageSectionTitle",
	"usageTable": "RtW54a_usageTable",
	"usageTableWrap": "RtW54a_usageTableWrap",
	"usageTabs": "RtW54a_usageTabs"
};

//#endregion
//#region src/client/usage-format.ts
/**
* Shared token-display formatting for the IP-pool client surfaces (the footer
* entry, the exit-stats modal, the usage panel). The helpers read the same
* bridge-shaped `TokenTotalsView` and must stay in lockstep so the footer,
* modal and panel never disagree about the same number.
*/
/** The all-in token figure the UI shows (input + output + cache read/write). */
function grandTotal(tokens) {
	return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
}
/** Compact token label: 1_234_567 → 1.2M, 856 → 856. */
function compact(value) {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(value);
}

//#endregion
//#region src/client/UsagePanel.tsx
/** `2026-10-14` → `10-14` (the year is noise in a 14-day window). */
function shortDay(day) {
	return day.length >= 10 ? day.slice(5) : day;
}
/** Clock label for a stamp; 0 reads the never placeholder. */
function timeLabel$1(epoch, never) {
	if (epoch <= 0) return never;
	return new Date(epoch).toLocaleString();
}
/**
* One ledger view: chips, daily bars, top sessions, project roll-up.
* @param props - the ledger view, the bound locale, the chart window.
* @returns the panel body (no tab chrome of its own).
*/
function UsagePanel({ usage, t, onClear, windowDays = 14 }) {
	const [confirming, setConfirming] = (0, react.useState)(false);
	const [clearing, setClearing] = (0, react.useState)(false);
	/** Which breakdown is on screen; sessions first, the view an operator scans first. */
	const [breakdown, setBreakdown] = (0, react.useState)("sessions");
	const tabBase = (0, react.useId)();
	const breakdownTabs = [{
		value: "sessions",
		label: t("usageTopSessions"),
		id: `${tabBase}-tab-sessions`,
		panelId: `${tabBase}-panel-sessions`
	}, {
		value: "projects",
		label: t("usageProjectsTitle"),
		id: `${tabBase}-tab-projects`,
		panelId: `${tabBase}-panel-projects`
	}];
	const activeBreakdown = breakdownTabs[breakdown === "projects" ? 1 : 0];
	const days = usage.days.slice(-windowDays);
	const heaviest = days.reduce((max, row) => Math.max(max, row.tokens), 0);
	const scoped = usage.scoped;
	const speed = usage.recentSpeed ?? 0;
	const sessions = usage.sessions;
	const projects = usage.projects;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: usage_panel_module_css_default.usagePanel,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: shared_module_css_default.statsSummary,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `${shared_module_css_default.statsChip} ${usage_panel_module_css_default.usageScopeChip}`,
						children: usage.scope === "run" ? t("usageScopeRun") : t("usageScopeTotal")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummaryRequests", { count: scoped.requests.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummaryTokens", { count: compact(grandTotal(scoped)) })
					}),
					speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummarySpeed", { count: speed.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("usageSummarySessions", { count: sessions.length.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("usageSummaryDays", { count: usage.days.length.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: usage_panel_module_css_default.usageClear,
						children: confirming ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: usage_panel_module_css_default.usageClearPrompt,
								children: t("usageClearConfirm")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: usage_panel_module_css_default.usageClearDanger,
								"data-testid": "usage-clear-confirm",
								disabled: clearing,
								onClick: () => {
									setClearing(true);
									onClear().finally(() => {
										setClearing(false);
										setConfirming(false);
									});
								},
								children: t("usageClearYes")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								"data-testid": "usage-clear-cancel",
								disabled: clearing,
								onClick: () => setConfirming(false),
								children: t("usageClearCancel")
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							"data-testid": "usage-clear",
							title: t("usageClearHint"),
							onClick: () => setConfirming(true),
							children: t("usageClear")
						})
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: usage_panel_module_css_default.usageSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: usage_panel_module_css_default.usageSectionTitle,
					children: t("usageDailyTitle")
				}), days.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: shared_module_css_default.status,
					children: t("usageDailyEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: usage_panel_module_css_default.dayChart,
					children: days.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: usage_panel_module_css_default.dayColumn,
						title: `${shortDay(row.day)} · ${compact(row.tokens)} tok · ${t("usageRequestsShort", { count: row.requests.toLocaleString() })}`,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: usage_panel_module_css_default.dayTrack,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: usage_panel_module_css_default.dayBar,
									style: { height: `${heaviest === 0 ? 0 : Math.round(row.tokens / heaviest * 100)}%` }
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: usage_panel_module_css_default.dayLabel,
								children: shortDay(row.day)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: usage_panel_module_css_default.dayValue,
								children: [compact(row.tokens), " tok"]
							})
						]
					}, row.day))
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: usage_panel_module_css_default.usageSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
					items: breakdownTabs,
					value: breakdown,
					onChange: setBreakdown,
					label: t("usageBreakdownTitle"),
					className: usage_panel_module_css_default.usageTabs
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "tabpanel",
					id: activeBreakdown.panelId,
					"aria-labelledby": activeBreakdown.id,
					children: breakdown === "sessions" ? sessions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: shared_module_css_default.status,
						children: t("usageSessionsEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: usage_panel_module_css_default.usageTableWrap,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: usage_panel_module_css_default.usageTable,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColSession") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColProject") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColRequests") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColTokens") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLastUsed") })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: sessions.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: usage_panel_module_css_default.sessionLabel,
									title: row.id,
									children: row.label !== "" ? row.label : t("usageUnlabeled")
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.project === null ? t("statsNever") : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: usage_panel_module_css_default.projectLabel,
									title: row.project.path,
									children: row.project.title
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.requests.toLocaleString() }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(row.tokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: timeLabel$1(row.lastAt, t("statsNever")) })
							] }, row.id)) })]
						})
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: usage_panel_module_css_default.projectList,
						children: projects.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: usage_panel_module_css_default.projectRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: usage_panel_module_css_default.projectLabel,
								title: row.path,
								children: row.title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: usage_panel_module_css_default.projectMeta,
								children: t("usageProjectMeta", {
									sessions: row.sessions.toLocaleString(),
									tokens: compact(row.tokens),
									requests: row.requests.toLocaleString()
								})
							})]
						}, row.id))
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: usage_panel_module_css_default.usageFootnote,
				children: t("usageFootnote", {
					sessions: usage.stored.sessions.toLocaleString(),
					days: usage.stored.days.toLocaleString(),
					retention: usage.retentionDays.toLocaleString()
				})
			})
		]
	});
}

//#endregion
//#region src/client/pool-status-store.ts
function createPoolStatusStore(env) {
	let state = {
		status: null,
		error: null,
		updatedAt: 0
	};
	const listeners = /* @__PURE__ */ new Set();
	const rates = /* @__PURE__ */ new Map();
	let seq = 0;
	let inFlight = null;
	let timer = null;
	let detachVisibility = null;
	const emit = () => {
		for (const listener of [...listeners]) listener();
	};
	const clearTimer = () => {
		if (timer !== null) env.clearTimer(timer);
		timer = null;
	};
	const schedule = () => {
		clearTimer();
		if (rates.size === 0 || env.isHidden()) return;
		timer = env.setTimer(() => {
			timer = null;
			poll();
		}, Math.min(...rates.values()));
	};
	const start = () => {
		inFlight?.controller.abort();
		const mine = ++seq;
		const controller = new AbortController();
		const promise = (async () => {
			let reply;
			try {
				reply = await env.fetchStatus(controller.signal);
			} catch (err) {
				reply = {
					ok: false,
					code: "client-network",
					message: err instanceof Error ? err.message : String(err)
				};
			}
			if (mine !== seq) return;
			inFlight = null;
			if (reply.ok && reply.value != null) state = {
				status: reply.value,
				error: null,
				updatedAt: env.now()
			};
			else if (!reply.ok) state = {
				...state,
				error: {
					code: reply.code,
					message: reply.message
				}
			};
			else state = {
				...state,
				error: {
					code: "client-bad-response",
					message: ""
				}
			};
			emit();
			schedule();
		})();
		inFlight = {
			controller,
			promise
		};
		return promise;
	};
	/** A timer tick joins the request in flight instead of starting another. */
	const poll = () => inFlight?.promise ?? start();
	const onVisibility = () => {
		if (env.isHidden()) clearTimer();
		else poll();
	};
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => state,
		refresh: () => start(),
		setRate(key, ms) {
			const first = rates.size === 0;
			rates.set(key, ms);
			if (!first) {
				if (inFlight === null) schedule();
				return;
			}
			detachVisibility = env.onVisibilityChange(onVisibility);
			if (env.isHidden()) return;
			poll();
		},
		removeRate(key) {
			if (!rates.delete(key)) return;
			if (rates.size > 0) {
				if (inFlight === null) schedule();
				return;
			}
			clearTimer();
			detachVisibility?.();
			detachVisibility = null;
		}
	};
}

//#endregion
//#region src/client/usePoolStatus.ts
let shared = null;
/** The page-wide store, created on first use with the browser environment. */
function poolStatusStore() {
	shared ??= createPoolStatusStore({
		fetchStatus: (signal) => postBridge("/status", {}, { signal }),
		setTimer: (run, ms) => window.setTimeout(run, ms),
		clearTimer: (handle) => window.clearTimeout(handle),
		isHidden: () => document.hidden,
		onVisibilityChange: (listener) => {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
		now: () => Date.now()
	});
	return shared;
}
/**
* Subscribe to the pool status.
* @param interval - this caller's poll interval in ms, or a function of the
*   current status (e.g. faster while probing); null = read only, no polling.
* @returns the shared state plus a forced refresh.
*/
function usePoolStatus(interval) {
	const store = poolStatusStore();
	const state = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
	const intervalMs = typeof interval === "function" ? interval(state.status) : interval;
	const key = (0, react.useRef)(null);
	key.current ??= Symbol("pool-status");
	(0, react.useEffect)(() => {
		const id = key.current;
		if (intervalMs === null) store.removeRate(id);
		else store.setRate(id, intervalMs);
	}, [store, intervalMs]);
	(0, react.useEffect)(() => () => store.removeRate(key.current), [store]);
	return {
		...state,
		refresh: store.refresh
	};
}

//#endregion
//#region \0dsh-css:src/client/footer.module.css.mjs
const css$3 = ".YDMsbq_footerEntry{width:100%;color:var(--dsw-alias-label-primary,#1f2329);text-align:left;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:12px;display:flex;container-type:inline-size}.YDMsbq_footerEntry:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-color:var(--dsw-alias-border-l2,#d0d7de)}.YDMsbq_footerIcon{color:var(--dsw-alias-state-business-primary,#4f8cff);font-size:14px;line-height:1}.YDMsbq_footerText{flex-direction:column;min-width:0;display:flex}.YDMsbq_footerMain{white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600;line-height:1.25;overflow:hidden}.YDMsbq_footerUnit{color:var(--dsw-alias-label-secondary,#4b5563);font-weight:400}.YDMsbq_footerSub{color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.YDMsbq_footerEntryCompact{justify-content:center;gap:4px;padding:6px 4px}.YDMsbq_footerCompact{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.YDMsbq_footerCompactOnNarrow{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;flex-direction:column;align-items:flex-start;min-width:0;font-size:11px;display:none;overflow:hidden}.YDMsbq_footerCompactLine{text-overflow:ellipsis;max-width:100%;line-height:1.3;overflow:hidden}.YDMsbq_footerStale{color:var(--dsw-alias-state-warning-primary,#9a6700)}@container (width<=180px){.YDMsbq_footerText{display:none}.YDMsbq_footerCompactOnNarrow{display:flex}}";
const tagId$3 = "dsh-opencode2free-provider/footer.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId$3;
	tag.textContent = css$3;
	document.head.appendChild(tag);
}
var footer_module_css_default = {
	"footerCompact": "YDMsbq_footerCompact",
	"footerCompactLine": "YDMsbq_footerCompactLine",
	"footerCompactOnNarrow": "YDMsbq_footerCompactOnNarrow",
	"footerEntry": "YDMsbq_footerEntry",
	"footerEntryCompact": "YDMsbq_footerEntryCompact",
	"footerIcon": "YDMsbq_footerIcon",
	"footerMain": "YDMsbq_footerMain",
	"footerStale": "YDMsbq_footerStale",
	"footerSub": "YDMsbq_footerSub",
	"footerText": "YDMsbq_footerText",
	"footerUnit": "YDMsbq_footerUnit"
};

//#endregion
//#region \0dsh-css:src/client/stats-modal.module.css.mjs
const css$2 = ".cx5Jyq_statsModal.cx5Jyq_statsModal{width:min(1040px,100%);height:min(640px,100%);max-height:100%}.cx5Jyq_statsContent,.cx5Jyq_statsContent>div:last-child{flex:auto;min-height:0;overflow:hidden}.cx5Jyq_statsSummaryAction{margin-left:auto}.cx5Jyq_statsTabs{margin-bottom:12px}.cx5Jyq_statsPane{flex:auto;min-height:0;overflow-y:auto}.cx5Jyq_statsWrap{overflow-x:hidden}.cx5Jyq_statsTable{table-layout:fixed;border-collapse:collapse;width:100%;font-size:12px}.cx5Jyq_statsTable th:first-child{width:20%}.cx5Jyq_statsTable th:nth-child(2){width:7%}.cx5Jyq_statsTable th:nth-child(3){width:9%}.cx5Jyq_statsTable th:nth-child(4){width:8%}.cx5Jyq_statsTable th:nth-child(5){width:7%}.cx5Jyq_statsTable th:nth-child(6){width:13%}.cx5Jyq_statsTable th:nth-child(7){width:6%}.cx5Jyq_statsTable th:nth-child(8){width:7%}.cx5Jyq_statsTable th:nth-child(9){width:11%}.cx5Jyq_statsTable th:nth-child(10){width:12%}.cx5Jyq_statsTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#6b7280);border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);white-space:normal;padding:6px;font-weight:600}.cx5Jyq_statsSortButton{font:inherit;color:inherit;cursor:pointer;background:0 0;border:0;align-items:center;gap:3px;padding:0;display:inline-flex}.cx5Jyq_statsSortButton:hover{color:var(--dsw-alias-label-primary,#1f2329)}.cx5Jyq_statsSortButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4f8cff);outline-offset:1px;border-radius:3px}.cx5Jyq_statsSortArrow{text-align:center;min-width:10px;font-size:9px;line-height:1}.cx5Jyq_statsTable td{border-bottom:1px solid var(--dsw-alias-border-l3,#eaeef2);color:var(--dsw-alias-label-primary,#1f2329);white-space:normal;overflow-wrap:anywhere;padding:6px}.cx5Jyq_statsOutputCell{white-space:nowrap;overflow-wrap:normal}.cx5Jyq_statsRowMuted td{color:var(--dsw-alias-label-tertiary,#6b7280)}.cx5Jyq_statsTable tbody tr:hover td{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}.cx5Jyq_statsRowLocal td{border-top:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#4b5563);border-bottom:none;font-weight:500}.cx5Jyq_statsEndpoint{color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;margin-left:4px;font-size:.86em}.cx5Jyq_statsDot{vertical-align:middle;border-radius:50%;width:7px;height:7px;margin-right:5px;display:inline-block}.cx5Jyq_statsDotOk{background:var(--dsw-alias-state-success-primary,#1a7f37)}.cx5Jyq_statsDotWarn{background:var(--dsw-alias-state-warning-primary,#9a6700)}.cx5Jyq_statsDotBad{background:var(--dsw-alias-state-error-primary,#d1242f)}.cx5Jyq_statsRegion{font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap}.cx5Jyq_statsActions{white-space:nowrap}.cx5Jyq_rowAction{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:5px;justify-content:center;align-items:center;padding:3px 5px;line-height:0;display:inline-flex}.cx5Jyq_rowAction:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.cx5Jyq_rowAction:disabled{opacity:.5;cursor:default}.cx5Jyq_rowActionActive,.cx5Jyq_rowActionActive:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff}.cx5Jyq_statsInflight{background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff;border-radius:999px;margin-right:6px;padding:0 6px;font-size:10px;line-height:1.6;display:inline-block}.cx5Jyq_statsToast{z-index:2;background:var(--dsw-alias-toast-bg,#1f2937);max-width:min(360px,100% - 40px);color:var(--dsw-alias-toast-label,#f9fafb);box-shadow:var(--dsw-shadow-lv3,0 8px 24px #0000002e);animation:cx5Jyq_stats-toast-in .16s ease-out, cx5Jyq_stats-toast-fade .3s ease var(--stats-toast-hold,3s) forwards;border-radius:8px;padding:8px 14px;font-size:12px;line-height:1.5;position:absolute;bottom:20px;right:20px}.cx5Jyq_statsToastWarn{color:var(--dsw-alias-state-warning-primary,#d29922)}@keyframes cx5Jyq_stats-toast-in{0%{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes cx5Jyq_stats-toast-fade{to{opacity:0;visibility:hidden}}@media (prefers-reduced-motion:reduce){.cx5Jyq_statsToast{animation:cx5Jyq_stats-toast-fade .3s ease var(--stats-toast-hold,3s) forwards}}";
const tagId$2 = "dsh-opencode2free-provider/stats-modal.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId$2;
	tag.textContent = css$2;
	document.head.appendChild(tag);
}
var stats_modal_module_css_default = {
	"rowAction": "cx5Jyq_rowAction",
	"rowActionActive": "cx5Jyq_rowActionActive",
	"stats-toast-fade": "cx5Jyq_stats-toast-fade",
	"stats-toast-in": "cx5Jyq_stats-toast-in",
	"statsActions": "cx5Jyq_statsActions",
	"statsContent": "cx5Jyq_statsContent",
	"statsDot": "cx5Jyq_statsDot",
	"statsDotBad": "cx5Jyq_statsDotBad",
	"statsDotOk": "cx5Jyq_statsDotOk",
	"statsDotWarn": "cx5Jyq_statsDotWarn",
	"statsEndpoint": "cx5Jyq_statsEndpoint",
	"statsInflight": "cx5Jyq_statsInflight",
	"statsModal": "cx5Jyq_statsModal",
	"statsOutputCell": "cx5Jyq_statsOutputCell",
	"statsPane": "cx5Jyq_statsPane",
	"statsRegion": "cx5Jyq_statsRegion",
	"statsRowLocal": "cx5Jyq_statsRowLocal",
	"statsRowMuted": "cx5Jyq_statsRowMuted",
	"statsSortArrow": "cx5Jyq_statsSortArrow",
	"statsSortButton": "cx5Jyq_statsSortButton",
	"statsSummaryAction": "cx5Jyq_statsSummaryAction",
	"statsTable": "cx5Jyq_statsTable",
	"statsTabs": "cx5Jyq_statsTabs",
	"statsToast": "cx5Jyq_statsToast",
	"statsToastWarn": "cx5Jyq_statsToastWarn",
	"statsWrap": "cx5Jyq_statsWrap"
};

//#endregion
//#region src/client/ExitStatsEntry.tsx
/** Cache share of one bucket, for the per-row note (0 hides the note). */
function cacheTotal(tokens) {
	return tokens.cacheReadTokens + tokens.cacheWriteTokens;
}
/**
* The outcome toast's two clocks: HOLD is full-opacity reading time;
* FADE matches the stylesheet's dismiss animation so the element unmounts
* exactly when it stops being visible.
*/
const TOAST_HOLD_MS = 3e3;
const TOAST_FADE_MS = 300;
/** Clock label for a last-used stamp; 0 reads the never placeholder. */
function timeLabel(epoch, never) {
	if (epoch <= 0) return never;
	return new Date(epoch).toLocaleTimeString();
}
/** An exit row reads "usable" when it is probed healthy (state ok) and not
*  cooling; bans are per-model, so they never hide a whole row. */
function isUsable(exit) {
	return exit.state === "ok" && !exit.cooling;
}
/** One exit's value under a sort key. */
function sortMetric(exit, key) {
	if (key === "input") return exit.tokens.inputTokens;
	if (key === "output") return exit.tokens.outputTokens;
	if (key === "cache") return cacheTotal(exit.tokens);
	return exit.requests;
}
/**
* The footer entry: one register()-mounted button plus its modal.
* @param props - sidebar column state, locale-bound `t`, standard seats.
* @returns the button and (when open) the portaled stats dialog.
*/
function ExitStatsEntry({ wide, t }) {
	const [open, setOpen] = (0, react.useState)(false);
	const { status, error, updatedAt, refresh } = usePoolStatus(open ? 2e3 : 1e4);
	const stale = error !== null && status !== null;
	/** Headline ordering contract: newest click wins, request count is home. */
	const [sort, setSort] = (0, react.useState)({
		key: "requests",
		dir: "desc"
	});
	/** Which pane the modal shows: the exit table, or the traffic breakdown. */
	const [tab, setTab] = (0, react.useState)("exits");
	/** The pane's own scroll container; a pane switch resets its offset. */
	const paneRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (paneRef.current !== null) paneRef.current.scrollTop = 0;
	}, [tab]);
	/** The row action in flight (its key), so every button disables together. */
	const [busy, setBusy] = (0, react.useState)("");
	/**
	* The last action's outcome, shown as a toast DOCKED at the modal's
	* bottom-right corner and dismissed on its own clock. `seq` restarts the
	* show cycle when the same text fires twice in a row.
	*/
	const [note, setNote] = (0, react.useState)(null);
	const noteSeq = (0, react.useRef)(0);
	/** Show one outcome toast; every success/failure line funnels through here. */
	const showNote = (0, react.useCallback)((text, warn) => {
		noteSeq.current += 1;
		setNote({
			text,
			warn,
			seq: noteSeq.current
		});
	}, []);
	(0, react.useEffect)(() => {
		if (note === null) return;
		const timer = window.setTimeout(() => setNote(null), TOAST_HOLD_MS + TOAST_FADE_MS);
		return () => window.clearTimeout(timer);
	}, [note]);
	/** 清空: drop the usage ledger, then re-read so every figure drops together. */
	const clearUsage = (0, react.useCallback)(async () => {
		setNote(null);
		const reply = await postBridge("/usage", { action: "reset" });
		if (!reply.ok || reply.value?.cleared !== true) {
			showNote(reply.ok ? t("statsActionFailed") : bridgeErrorText(reply, t("statsActionFailed")), true);
			return false;
		}
		showNote(t("usageCleared"), false);
		await refresh();
		return true;
	}, [
		refresh,
		showNote,
		t
	]);
	/**
	* 订阅「立即刷新」: the same /probe scope the settings card sends. The POST
	* answers only when the refresh round ends, so the busy flag covers the whole
	* pull; the follow-up /status read shows the converted rows.
	*/
	const refreshSubscriptions = (0, react.useCallback)(async () => {
		setBusy("refresh-subscriptions");
		setNote(null);
		try {
			const reply = await probeAction({ scope: "subscription" });
			showNote(reply.ok ? t("statsSubscriptionRefreshed") : bridgeErrorText(reply, t("statsActionFailed")), !reply.ok);
		} finally {
			setBusy("");
			await refresh();
		}
	}, [
		refresh,
		showNote,
		t
	]);
	/**
	* One row action (固定 / 取消固定 / 轮换) over the bridge, which owns the
	* listener check, the settings write and the live pin. The toast reports what
	* actually happened, including the host's refusal text (e.g. an unreachable
	* exit) and a rotation's two outcomes.
	*/
	const runExitAction = (0, react.useCallback)(async (action, exitId) => {
		setBusy(`${action}:${exitId ?? ""}`);
		setNote(null);
		try {
			const reply = await exitAction(action, exitId);
			if (!reply.ok || reply.value == null) {
				showNote(reply.ok ? t("statsActionFailed") : bridgeErrorText(reply, t("statsActionFailed")), true);
				return;
			}
			const value = reply.value;
			if (action === "rotate" && value.busy === true) {
				showNote(t("statsActionBusy"), true);
				return;
			}
			const text = action === "rotate" ? value.promoted === true ? t("statsActionReplaced") : t("statsActionDemoted") : action === "unpin" ? t("statsActionUnpinned") : action === "pin-local" ? t("statsActionPinnedLocal") : t("statsActionPinned");
			showNote(value.persisted === false ? `${text} · ${t("statsActionVolatile")}` : text, value.persisted === false);
		} finally {
			setBusy("");
			await refresh();
		}
	}, [
		refresh,
		showNote,
		t
	]);
	const totals = (0, react.useMemo)(() => {
		const localRequests = status?.local?.requests ?? 0;
		const localTokens = status?.local?.tokens;
		const exits = status?.exits ?? [];
		return {
			requests: exits.reduce((sum, exit) => sum + exit.requests, 0) + localRequests,
			tokens: exits.reduce((sum, exit) => sum + grandTotal(exit.tokens), 0) + (localTokens === void 0 ? 0 : grandTotal(localTokens)),
			inFlight: exits.reduce((sum, exit) => sum + exit.inFlight, 0),
			speed: status?.recentSpeed ?? 0
		};
	}, [status]);
	/**
	* The footer's own numbers: the ledger's ALL-TIME request total, TODAY's
	* token spend (`todayTokens`, never the card's scope) and the recent-window
	* speed. Falls back to the live totals when the host serves no ledger.
	*/
	const overview = (0, react.useMemo)(() => {
		if (status === null) return totals;
		const ledger = status.usage;
		if (ledger === null || ledger === void 0) return totals;
		return {
			requests: ledger.total.requests,
			tokens: status.todayTokens ?? 0,
			inFlight: totals.inFlight,
			speed: status.recentSpeed ?? 0
		};
	}, [status, totals]);
	const usable = status?.availableTotal ?? 0;
	const total = status?.total ?? 0;
	/** Pool off = no traffic goes through an exit: the table shows the 本机 row alone. */
	const poolOff = status !== null && status.enabled === false;
	/** The 订阅 refresh button exists only while subscriptions are configured. */
	const hasSubscriptions = (status?.subscription?.urlCount ?? 0) > 0;
	const rows = (0, react.useMemo)(() => {
		if (poolOff) return [];
		const unknown = Number.POSITIVE_INFINITY;
		return [...status?.exits ?? []].sort((left, right) => {
			if (sort.key === "latency") {
				const a = left.latencyMs > 0 ? left.latencyMs : unknown;
				const b = right.latencyMs > 0 ? right.latencyMs : unknown;
				if (a === b) return right.requests - left.requests || left.id.localeCompare(right.id);
				if (a === unknown) return 1;
				if (b === unknown) return -1;
				return sort.dir === "asc" ? a - b : b - a;
			}
			const directed = sortMetric(left, sort.key) - sortMetric(right, sort.key);
			return (sort.dir === "asc" ? directed : -directed) || right.requests - left.requests || left.id.localeCompare(right.id);
		});
	}, [
		status,
		poolOff,
		sort
	]);
	/** One sortable column header: click once for that column descending, again to flip. */
	const sortableHeader = (key, label) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
		"aria-sort": sort.key === key ? sort.dir === "asc" ? "ascending" : "descending" : "none",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: stats_modal_module_css_default.statsSortButton,
			onClick: () => setSort((current) => ({
				key,
				dir: current.key === key && current.dir === "desc" ? "asc" : "desc"
			})),
			children: [label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: stats_modal_module_css_default.statsSortArrow,
				"aria-hidden": "true",
				children: sort.key === key ? sort.dir === "asc" ? "▲" : "▼" : ""
			})]
		})
	});
	/** The two panes as platform tabs, each linked to the panel rendered below. */
	const tabs = [{
		value: "exits",
		label: t("tabExits"),
		id: "oc2dsh-stats-tab-exits",
		panelId: "oc2dsh-stats-panel-exits"
	}, {
		value: "usage",
		label: t("tabUsage"),
		id: "oc2dsh-stats-tab-usage",
		panelId: "oc2dsh-stats-panel-usage"
	}];
	const activeTab = tabs[tab === "usage" ? 1 : 0];
	const staleText = stale ? t("statsStale", { time: timeLabel(updatedAt, t("statsNever")) }) : "";
	const footerSummary = `${t("footerRequests", { count: overview.requests.toLocaleString() })} · ${compact(overview.tokens)} tok${overview.speed > 0 ? ` · ${t("footerSpeed", { count: overview.speed.toLocaleString() })}` : ""}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: wide ? footer_module_css_default.footerEntry : `${footer_module_css_default.footerEntry} ${footer_module_css_default.footerEntryCompact}`,
		onClick: () => setOpen(true),
		title: stale ? `${t("footerTitle")} · ${staleText}` : t("footerTitle"),
		"aria-haspopup": "dialog",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: stale ? `${footer_module_css_default.footerIcon} ${footer_module_css_default.footerStale}` : footer_module_css_default.footerIcon,
				"aria-hidden": "true",
				children: "◈"
			}),
			wide && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: footer_module_css_default.footerText,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: footer_module_css_default.footerMain,
					children: status === null ? t("footerDisabled") : poolOff ? t("footerLocal") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [usable, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: footer_module_css_default.footerUnit,
						children: [
							" / ",
							total,
							" ",
							t("footerLabel")
						]
					})] })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: footer_module_css_default.footerSub,
					children: [
						t("footerRequests", { count: overview.requests.toLocaleString() }),
						" · ",
						compact(overview.tokens),
						" tok",
						overview.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", t("footerSpeed", { count: overview.speed.toLocaleString() })] })
					]
				})]
			}),
			wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: footer_module_css_default.footerCompactOnNarrow,
				title: footerSummary,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: footer_module_css_default.footerCompactLine,
					children: status === null ? "—" : `${compact(overview.tokens)} tok`
				}), status !== null && overview.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: footer_module_css_default.footerCompactLine,
					children: t("footerSpeed", { count: overview.speed.toLocaleString() })
				})]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: footer_module_css_default.footerCompact,
				title: footerSummary,
				children: status === null ? "—" : `${compact(overview.tokens)} tok`
			})
		]
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose: () => setOpen(false),
		title: t("statsTitle"),
		closeLabel: t("statsClose"),
		description: tab === "usage" ? t("statsDescriptionUsage", { days: String(status?.usage?.retentionDays ?? 90) }) : t("statsDescription"),
		className: stats_modal_module_css_default.statsModal,
		contentClassName: stats_modal_module_css_default.statsContent,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
				items: tabs,
				value: tab,
				onChange: setTab,
				label: t("statsTabsLabel"),
				className: stats_modal_module_css_default.statsTabs
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: paneRef,
				className: stats_modal_module_css_default.statsPane,
				role: "tabpanel",
				id: activeTab.panelId,
				"aria-labelledby": activeTab.id,
				children: [stale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: shared_module_css_default.statusStale,
					role: "status",
					"data-testid": "stats-stale",
					children: staleText
				}), tab === "usage" ? status?.usage == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: shared_module_css_default.status,
					children: error !== null && status === null ? t("statsError") : t("usageNoStore")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsagePanel, {
					usage: status.usage,
					t,
					onClear: clearUsage
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: shared_module_css_default.statsSummary,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: poolOff ? t("footerDisabled") : t("footerUsable", {
									usable,
									total
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummaryRequests", { count: totals.requests.toLocaleString() })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummaryTokens", { count: compact(totals.tokens) })
							}),
							totals.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummarySpeed", { count: totals.speed.toLocaleString() })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummaryInflight", { count: totals.inFlight })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummaryLocal", { count: (status?.local?.requests ?? 0).toLocaleString() })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.statsChip,
								children: t("statsSummaryDirect", { count: status?.direct.requests ?? 0 })
							}),
							hasSubscriptions && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								className: stats_modal_module_css_default.statsSummaryAction,
								"data-testid": "stats-refresh-subscriptions",
								disabled: busy !== "",
								title: t("statsRefreshSubscriptionsHint"),
								onClick: () => {
									refreshSubscriptions();
								},
								children: t("subscriptionRefreshNow")
							})
						]
					}),
					poolOff && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: shared_module_css_default.status,
						children: status?.deferredReason !== void 0 && status.deferredReason !== "" ? t("statsPoolDeferred", { reason: status.deferredReason }) : status?.runtimeReady === false ? t("statsPoolNotReady") : t("statsPoolOff")
					}),
					!poolOff && rows.length === 0 && (status?.local?.requests ?? 0) === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: shared_module_css_default.status,
						children: error !== null && status === null ? t("statsError") : t("statsEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: stats_modal_module_css_default.statsWrap,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: stats_modal_module_css_default.statsTable,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColIp") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColRegion") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColState") }),
								sortableHeader("requests", t("statsColRequests")),
								sortableHeader("input", t("statsColInput")),
								sortableHeader("output", t("statsColOutput")),
								sortableHeader("cache", t("statsColCache")),
								sortableHeader("latency", t("statsColLatency")),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLastUsed") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColActions") })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [rows.map((exit) => {
								const usableRow = isUsable(exit) && exit.demoted !== true;
								const dotClass = usableRow ? stats_modal_module_css_default.statsDotOk : exit.state === "dead" ? stats_modal_module_css_default.statsDotBad : stats_modal_module_css_default.statsDotWarn;
								const stateLabel = exit.demoted === true ? t("stateDemoted") : usableRow ? t("statsStateUsable") : exit.cooling ? t("stateCooling") : exit.state === "dead" ? t("stateDead") : t("statsStateUnverified");
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									className: usableRow ? void 0 : stats_modal_module_css_default.statsRowMuted,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: shared_module_css_default.mono,
											title: exit.exitLocation || void 0,
											children: [
												exit.exitIP !== "" ? exit.exitIP : t("statsNever"),
												exit.pinned ? ` · ${t("exitPinnedMark")}` : "",
												exit.exitIP === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: stats_modal_module_css_default.statsEndpoint,
													children: exit.id
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: stats_modal_module_css_default.statsRegion,
											title: exit.exitLocation || void 0,
											children: regionCode(exit.exitLocation) || t("statsNever")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${stats_modal_module_css_default.statsDot} ${dotClass}`,
											"aria-hidden": "true"
										}), stateLabel] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.requests.toLocaleString() }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(exit.tokens.inputTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: stats_modal_module_css_default.statsOutputCell,
											children: [compact(exit.tokens.outputTokens), (exit.speed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: stats_modal_module_css_default.statsEndpoint,
												children: t("statsSpeedNote", { count: (exit.speed ?? 0).toLocaleString() })
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: cacheTotal(exit.tokens) > 0 ? compact(cacheTotal(exit.tokens)) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : t("statsNever") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [exit.inFlight > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: stats_modal_module_css_default.statsInflight,
											children: t("statsInflight", { count: exit.inFlight })
										}), timeLabel(exit.lastUsedAt, t("statsNever"))] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: stats_modal_module_css_default.statsActions,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: shared_module_css_default.actionGroup,
												children: [exit.pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: `${stats_modal_module_css_default.rowAction} ${stats_modal_module_css_default.rowActionActive}`,
													disabled: busy !== "",
													title: t("statsUnpinHint"),
													"aria-label": t("statsUnpin"),
													onClick: () => {
														runExitAction("unpin");
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnpinIcon, {})
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: stats_modal_module_css_default.rowAction,
													disabled: busy !== "",
													title: t("statsPinHint"),
													"aria-label": t("statsPin"),
													onClick: () => {
														runExitAction("pin", exit.id);
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinIcon, {})
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: stats_modal_module_css_default.rowAction,
													disabled: busy !== "",
													title: t("statsRotateHint"),
													"aria-label": t("statsRotate"),
													onClick: () => {
														runExitAction("rotate", exit.id);
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RotateIcon, {})
												})]
											})
										})
									]
								}, exit.id);
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								className: stats_modal_module_css_default.statsRowLocal,
								"data-local-egress": true,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: shared_module_css_default.mono,
										children: t("statsLocalIp")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsNever") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${stats_modal_module_css_default.statsDot} ${stats_modal_module_css_default.statsDotOk}`,
										"aria-hidden": "true"
									}), t("statsLocalState")] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: (status?.local?.requests ?? 0).toLocaleString() }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: status?.local === void 0 ? t("statsNever") : compact(status.local.tokens.inputTokens) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: stats_modal_module_css_default.statsOutputCell,
										children: status?.local === void 0 ? t("statsNever") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [compact(status.local.tokens.outputTokens), (status.local.speed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: stats_modal_module_css_default.statsEndpoint,
											children: t("statsSpeedNote", { count: (status.local.speed ?? 0).toLocaleString() })
										})] })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: status?.local === void 0 || cacheTotal(status.local.tokens) === 0 ? "—" : compact(cacheTotal(status.local.tokens)) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsNever") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: timeLabel(status?.local?.lastUsedAt ?? 0, t("statsNever")) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: stats_modal_module_css_default.statsActions,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: shared_module_css_default.actionGroup,
											children: status?.pinned?.local === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: `${stats_modal_module_css_default.rowAction} ${stats_modal_module_css_default.rowActionActive}`,
												disabled: busy !== "",
												title: t("statsUnpinHint"),
												"aria-label": t("statsUnpin"),
												onClick: () => {
													runExitAction("unpin");
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnpinIcon, {})
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: stats_modal_module_css_default.rowAction,
												disabled: busy !== "",
												title: t("statsPinLocalHint"),
												"aria-label": t("statsPin"),
												onClick: () => {
													runExitAction("pin-local");
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinIcon, {})
											})
										})
									})
								]
							})] })]
						})
					})
				] })]
			}),
			note !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: note.warn ? `${stats_modal_module_css_default.statsToast} ${stats_modal_module_css_default.statsToastWarn}` : stats_modal_module_css_default.statsToast,
				style: { "--stats-toast-hold": `${TOAST_HOLD_MS}ms` },
				role: "status",
				children: note.text
			}, note.seq)
		]
	})] });
}

//#endregion
//#region \0dsh-css:src/client/exit-table.module.css.mjs
const css$1 = ".vKsQoW_table{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;display:block;overflow-x:auto}.vKsQoW_tableGrid{border-collapse:collapse;width:100%;font-size:12px}.vKsQoW_tableGrid th,.vKsQoW_tableGrid td{border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);text-align:left;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;padding:6px 8px}.vKsQoW_tableGrid th{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-2,#f6f8fa);font-weight:600}.vKsQoW_tableGrid tr:last-child td{border-bottom:none}.vKsQoW_tableGrid tbody tr:hover td{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}.vKsQoW_tableGrid td>*+*{margin-left:4px}.vKsQoW_stateCell{align-items:center;gap:6px;display:inline-flex}.vKsQoW_stateCooling{color:var(--dsw-alias-state-warning-primary,#9a6700)}.vKsQoW_stateDead{color:var(--dsw-alias-state-error-primary,#d1242f)}.vKsQoW_rowIcon{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:6px;align-items:center;padding:4px 7px;line-height:0;display:inline-flex}.vKsQoW_rowIcon:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.vKsQoW_rowIcon:disabled{opacity:.5;cursor:default}.vKsQoW_section{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fe80);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}.vKsQoW_rowList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.vKsQoW_row{align-items:center;gap:6px;display:flex}.vKsQoW_rowLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);flex:1 1 0;font-size:13px;overflow:hidden}.vKsQoW_collapseToggle{color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;background:0 0;border:none;align-self:flex-start;padding:2px 8px;font-size:12px}";
const tagId$1 = "dsh-opencode2free-provider/exit-table.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId$1;
	tag.textContent = css$1;
	document.head.appendChild(tag);
}
var exit_table_module_css_default = {
	"collapseToggle": "vKsQoW_collapseToggle",
	"row": "vKsQoW_row",
	"rowIcon": "vKsQoW_rowIcon",
	"rowLabel": "vKsQoW_rowLabel",
	"rowList": "vKsQoW_rowList",
	"section": "vKsQoW_section",
	"stateCell": "vKsQoW_stateCell",
	"stateCooling": "vKsQoW_stateCooling",
	"stateDead": "vKsQoW_stateDead",
	"table": "vKsQoW_table",
	"tableGrid": "vKsQoW_tableGrid"
};

//#endregion
//#region src/client/ExitTable.tsx
/** The state cell: a semantic StateDot plus the label beside it. */
function StateCell(props) {
	const { exit, t } = props;
	const cell = (state, label) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: exit_table_module_css_default.stateCell,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state }), label]
	});
	if (exit.state === "dead") return cell("error", t("stateDead"));
	if (exit.note === "abusive") return cell("warning", t("stateAbusive"));
	if (exit.demoted === true) return cell("warning", t("stateDemoted"));
	if (exit.cooling) return cell("warning", t("stateCooling"));
	if (exit.state === "ok") return cell("done", t("stateOk"));
	return cell("idle", t("stateUnknown"));
}
/** The 真实流量 cell: compact symbols on screen, the spelled-out counts for hover and screen readers. */
function PassiveCell(props) {
	const { passive, t } = props;
	const failed = passive.dead + passive.transport;
	if (passive.ok === 0 && passive.limited === 0 && passive.refused === 0 && failed === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: "—" });
	const label = t("exitPassiveLabel", {
		ok: String(passive.ok),
		limited: String(passive.limited),
		refused: String(passive.refused),
		failed: String(failed)
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		title: label,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			"aria-hidden": "true",
			children: `✓${passive.ok} 429:${passive.limited} 401/403:${passive.refused} ✗:${failed}`
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: shared_module_css_default.srOnly,
			children: label
		})]
	});
}
/** The settings card's exit table plus the folded model-ban list. */
function ExitTable(props) {
	const { status, t, onProbe, onPin, onRotate, busy } = props;
	const [bansOpen, setBansOpen] = (0, react.useState)(false);
	const bansId = (0, react.useId)();
	if (status === null) return null;
	const allBans = status.exits.flatMap((exit) => exit.bannedModels.map((ban) => ({
		exitId: exit.id,
		...ban
	})));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: exit_table_module_css_default.table,
		"data-testid": "ip-pool-exits",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			className: exit_table_module_css_default.tableGrid,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitAddress") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitSource") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitLatency") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitQuality") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitIp") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitState") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitPassive") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {})
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [status.exits.map((exit) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
					className: shared_module_css_default.mono,
					children: [exit.id, exit.pinned ? ` · ${t("exitPinnedMark")}` : ""]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.source }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? exit.quality : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: shared_module_css_default.mono,
					title: exit.exitLocation || void 0,
					children: exit.exitIP || "—"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateCell, {
					exit,
					t
				}) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: shared_module_css_default.mono,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PassiveCell, {
						passive: exit.passive,
						t
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => onProbe(exit.id),
					children: t("exitProbe")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: shared_module_css_default.actionGroup,
					children: [!exit.pinned && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: exit_table_module_css_default.rowIcon,
						disabled: busy,
						title: t("statsPinHint"),
						"aria-label": t("exitPin"),
						onClick: () => onPin(exit.id),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinIcon, {})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: exit_table_module_css_default.rowIcon,
						disabled: busy,
						title: t("statsRotateHint"),
						"aria-label": t("statsRotate"),
						onClick: () => onRotate(exit.id),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RotateIcon, {})
					})]
				})] })
			] }, exit.id)), status.exits.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
				colSpan: 8,
				className: shared_module_css_default.status,
				children: t("statusUnavailable")
			}) })] })]
		})
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: exit_table_module_css_default.section,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: exit_table_module_css_default.collapseToggle,
			"aria-expanded": bansOpen,
			"aria-controls": bansId,
			onClick: () => setBansOpen((open) => !open),
			children: [
				t(bansOpen ? "collapse" : "expand"),
				" · ",
				t("sectionBans"),
				" (",
				allBans.length,
				")"
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			id: bansId,
			hidden: !bansOpen,
			children: bansOpen && (allBans.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: shared_module_css_default.status,
				children: t("bansEmpty")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: exit_table_module_css_default.rowList,
				children: allBans.map((ban) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
					className: exit_table_module_css_default.row,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: exit_table_module_css_default.rowLabel,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ban.state === "banned" ? exit_table_module_css_default.stateDead : exit_table_module_css_default.stateCooling,
								children: ban.state === "banned" ? t("banBanned") : t("banSuspect")
							}),
							" · ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.mono,
								children: ban.exitId
							}),
							" × ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: shared_module_css_default.mono,
								children: ban.model
							})
						]
					})
				}, `${ban.exitId}|${ban.model}`))
			}))
		})]
	})] });
}

//#endregion
//#region \0dsh-css:src/client/form.module.css.mjs
const css = "._14utfq_body{flex-direction:column;gap:14px;display:flex}._14utfq_field{flex-direction:column;gap:6px;display:flex}._14utfq_fieldRow{grid-template-columns:1fr 1fr;gap:12px 16px;display:grid}._14utfq_fieldRow>*{min-width:0}@media (width<=720px){._14utfq_fieldRow{grid-template-columns:1fr}}._14utfq_fieldLabel{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:500}._14utfq_fieldHint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:1.5}._14utfq_fieldHead{align-items:center;gap:10px;display:flex}._14utfq_fieldHead>._14utfq_fieldLabel{flex:auto;min-width:0}._14utfq_fieldHeadAction{flex:none}._14utfq_fieldControl{width:100%;display:flex}._14utfq_fieldControlNarrow{max-width:120px}._14utfq_fieldControlMedium{max-width:420px}._14utfq_inputWrapInvalid{border-color:var(--dsw-alias-state-error-primary,#d1242f);outline:1px solid var(--dsw-alias-state-error-primary,#d1242f);outline-offset:-1px}._14utfq_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);width:100%;color:var(--dsw-alias-label-primary,#1f2329);color-scheme:light;border-radius:6px;padding:6px 8px;font-size:13px}._14utfq_input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-1px}body[data-ds-dark-theme] ._14utfq_input,body[data-ds-dark-theme] ._14utfq_textarea{color-scheme:dark}._14utfq_headerValue{overflow-wrap:anywhere;white-space:pre-wrap}._14utfq_textarea{resize:vertical;min-height:56px;font-family:inherit;line-height:1.5;}._14utfq_saveStatus{font-size:12px;line-height:1.4}._14utfq_saveStatusOk{color:var(--dsw-alias-state-success-primary,#1a7f37)}._14utfq_saveStatusError{color:var(--dsw-alias-state-error-primary,#d1242f)}._14utfq_settingRow{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:8px;align-items:flex-start;gap:12px;padding:12px 14px;display:flex}._14utfq_settingRowText{flex-direction:column;flex:auto;gap:2px;min-width:0;display:flex}._14utfq_settingRowTitle{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:600}._14utfq_settingRowControl{flex:none;align-items:center;padding-top:2px;display:flex}._14utfq_group{border-top:1px solid var(--dsw-alias-border-l2,#d0d7de);flex-direction:column;padding:6px 0 10px;display:flex}._14utfq_groupSummary{text-overflow:ellipsis;white-space:nowrap;max-width:60%;color:var(--dsw-alias-label-tertiary,#6b7280);margin-left:auto;padding-right:2px;font-size:12px;overflow:hidden}._14utfq_groupBody{flex-direction:column;gap:12px;padding:8px 0 4px 22px;display:flex}._14utfq_groupBodyHidden{display:none}._14utfq_groupHighlight{animation:1.2s _14utfq_group-flash}@keyframes _14utfq_group-flash{20%{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4f8cff)}}._14utfq_listItems{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}._14utfq_listItem{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:6px;align-items:center;gap:8px;padding:4px 6px 4px 10px;display:flex}._14utfq_listItemText{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);flex:1 1 0;font-size:13px;overflow:hidden}._14utfq_listItem>button{min-width:22px;height:22px;padding:0 4px}._14utfq_listItemNew{animation:.4s _14utfq_list-flash}@keyframes _14utfq_list-flash{30%{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#1a7f37) 10%, transparent)}}._14utfq_listAddRow{align-items:center;gap:8px;display:flex}._14utfq_listAddInput{flex:1 1 0;min-width:0}._14utfq_listAddRow>button{height:32px}._14utfq_listDup{color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px}._14utfq_chipRow{flex-wrap:wrap;align-items:center;gap:6px;display:flex}._14utfq_chip{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);max-width:240px;color:var(--dsw-alias-label-primary,#1f2329);border-radius:999px;align-items:center;gap:2px;padding:2px 4px 2px 10px;font-size:12px;display:inline-flex}._14utfq_chipText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}._14utfq_chipSub{color:var(--dsw-alias-label-tertiary,#6b7280);margin-left:4px;font-size:11px}._14utfq_chip>button{min-width:20px;height:20px;padding:0 4px}._14utfq_overviewBar{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);border-radius:8px;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 10px;font-size:12px;display:flex}._14utfq_compliance{color:var(--dsw-alias-label-tertiary,#6b7280);border-top:1px dashed var(--dsw-alias-border-l2,#d0d7de);padding-top:10px;font-size:11px;line-height:1.5}@media (prefers-reduced-motion:reduce){._14utfq_groupHighlight,._14utfq_listItemNew{animation:none}._14utfq_listItemNew{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#1a7f37) 10%, transparent)}}";
const tagId = "dsh-opencode2free-provider/form.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode2free-provider";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var form_module_css_default = {
	"body": "_14utfq_body",
	"chip": "_14utfq_chip",
	"chipRow": "_14utfq_chipRow",
	"chipSub": "_14utfq_chipSub",
	"chipText": "_14utfq_chipText",
	"compliance": "_14utfq_compliance",
	"field": "_14utfq_field",
	"fieldControl": "_14utfq_fieldControl",
	"fieldControlMedium": "_14utfq_fieldControlMedium",
	"fieldControlNarrow": "_14utfq_fieldControlNarrow",
	"fieldHead": "_14utfq_fieldHead",
	"fieldHeadAction": "_14utfq_fieldHeadAction",
	"fieldHint": "_14utfq_fieldHint",
	"fieldLabel": "_14utfq_fieldLabel",
	"fieldRow": "_14utfq_fieldRow",
	"group": "_14utfq_group",
	"group-flash": "_14utfq_group-flash",
	"groupBody": "_14utfq_groupBody",
	"groupBodyHidden": "_14utfq_groupBodyHidden",
	"groupHighlight": "_14utfq_groupHighlight",
	"groupSummary": "_14utfq_groupSummary",
	"headerValue": "_14utfq_headerValue",
	"input": "_14utfq_input",
	"inputWrapInvalid": "_14utfq_inputWrapInvalid",
	"list-flash": "_14utfq_list-flash",
	"listAddInput": "_14utfq_listAddInput",
	"listAddRow": "_14utfq_listAddRow",
	"listDup": "_14utfq_listDup",
	"listItem": "_14utfq_listItem",
	"listItemNew": "_14utfq_listItemNew",
	"listItemText": "_14utfq_listItemText",
	"listItems": "_14utfq_listItems",
	"overviewBar": "_14utfq_overviewBar",
	"saveStatus": "_14utfq_saveStatus",
	"saveStatusError": "_14utfq_saveStatusError",
	"saveStatusOk": "_14utfq_saveStatusOk",
	"settingRow": "_14utfq_settingRow",
	"settingRowControl": "_14utfq_settingRowControl",
	"settingRowText": "_14utfq_settingRowText",
	"settingRowTitle": "_14utfq_settingRowTitle",
	"textarea": "_14utfq_textarea"
};

//#endregion
//#region src/client/fields/Group.tsx
/** First-visit fold state: high-frequency groups open, advanced ones folded. */
const GROUP_DEFAULTS = {
	sources: true,
	scheduling: false,
	probe: false,
	usage: true,
	headers: false,
	models: false,
	exits: true
};
/** localStorage key holding the operator's fold preferences (schema v1). */
const GROUP_STATE_KEY = "oc2dsh:form-groups:v1";
/** Read the persisted fold map; a missing/corrupt entry falls back to defaults. */
function loadGroupState() {
	try {
		const raw = localStorage.getItem(GROUP_STATE_KEY);
		if (raw === null) return { ...GROUP_DEFAULTS };
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { ...GROUP_DEFAULTS };
		return {
			...GROUP_DEFAULTS,
			...parsed
		};
	} catch {
		return { ...GROUP_DEFAULTS };
	}
}
/**
* One collapsible settings group: a DisclosureRow header with the title and a
* folded-state summary, and a body that stays MOUNTED while folded
* (display:none) so half-typed list drafts and focus survive a fold.
*/
function Group(props) {
	const { id, title, summary, open, highlight, onToggle, children } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: highlight ? `${form_module_css_default.group} ${form_module_css_default.groupHighlight}` : form_module_css_default.group,
		"data-group": id,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
			icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {}),
			title,
			open,
			expandable: true,
			expandOnRowClick: true,
			onToggle,
			collapsedContent: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.groupSummary,
				children: summary
			})
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: open ? form_module_css_default.groupBody : form_module_css_default.groupBodyHidden,
			children
		})]
	});
}

//#endregion
//#region src/client/fields/LocalFamilyPicker.tsx
const ORDER$1 = [
	"auto",
	"ipv4",
	"ipv6"
];
/**
* 本机出口协议族 picker: which IP family the LOCAL egress dials with. `auto`
* prefers IPv6 where this machine has a routable address and keeps the
* happy-eyeballs fallback to IPv4; `ipv4`/`ipv6` pin the family
* (src/pool/local-family.ts).
*/
function LocalFamilyPicker(props) {
	const { value, disabled, t, onChange } = props;
	const [open, setOpen] = (0, react.useState)(false);
	const label = {
		auto: t("localIpFamilyAuto"),
		ipv4: t("localIpFamilyIpv4"),
		ipv6: t("localIpFamilyIpv6")
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Menu, {
		open,
		onClose: () => setOpen(false),
		anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "outline",
			size: "sm",
			"data-testid": "local-ip-family-select",
			disabled: disabled === true,
			onClick: () => setOpen((current) => !current),
			children: [label[value], /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {})]
		}),
		items: ORDER$1.map((id) => ({
			id,
			label: label[id]
		})),
		selectedIds: [value],
		onSelect: (id) => {
			onChange(id);
			setOpen(false);
		},
		align: "start",
		side: "bottom",
		portal: true
	});
}

//#endregion
//#region src/proxy-entry.ts
const SCHEMES = {
	http: "http",
	https: "http",
	socks4: "socks5",
	socks5: "socks5",
	socks5h: "socks5"
};
const AUTHORITY = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})$/;
/**
* Parse `[scheme://]host:port`. Credentials (`user:pw@`) are refused: the
* entry is the row id, which lands in logs, /status and usage.json.
*/
function parseManualProxy(entry) {
	const trimmed = entry.trim();
	if (trimmed === "") return null;
	const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed);
	let protocol = "http";
	if (schemeMatch) {
		const mapped = SCHEMES[schemeMatch[1].toLowerCase()];
		if (mapped === void 0) return null;
		protocol = mapped;
	}
	const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed;
	const match = AUTHORITY.exec(rest);
	if (match === null) return null;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return null;
	return {
		id: trimmed,
		protocol,
		host: match[1],
		port
	};
}
/** True when {@link parseManualProxy} accepts the entry. */
function isManualProxyEntry(entry) {
	return parseManualProxy(entry) !== null;
}

//#endregion
//#region src/model-context.ts
/** A window above 16,777,216 tokens is not a real model — reject typos. */
const MAX_CONTEXT_WINDOW = 16777216;
/**
* Floor for an override. Smaller windows make the host's compaction budget
* (`contextWindow - reservedCompletionTokens`) collapse, so they are refused
* instead of producing a session that cannot compact.
*/
const MIN_CONTEXT_WINDOW = 1024;
/** A context override is a hand-written list; more than this is a mistake. */
const MAX_MODEL_CONTEXT_WINDOWS = 128;
/** Model ids are opaque; match everything a Zen id can contain except the
*  separators and whitespace, so a stray space cannot create a phantom id. */
const MODEL_ID = /^[^\s=:]+$/;
const MODEL_ID_MAX = 200;
function validModelId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MODEL_ID_MAX && MODEL_ID.test(value);
}
function validWindow(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW;
}
/**
* Strict boundary: the settings editor and any explicit write path. Throws
* with a user-facing message so the card can show why a draft was refused.
*/
function normalizeModelContextWindows(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Model context windows must be an object");
	const entries = Object.entries(input);
	if (entries.length > MAX_MODEL_CONTEXT_WINDOWS) throw new Error(`At most ${String(MAX_MODEL_CONTEXT_WINDOWS)} model context windows are allowed`);
	const normalized = /* @__PURE__ */ new Map();
	for (const [rawId, rawWindow] of entries) {
		const id = rawId.trim();
		if (!validModelId(id)) throw new Error(`Invalid model id: ${rawId}`);
		if (!validWindow(rawWindow)) throw new Error(`Context window for ${id} must be an integer between ${String(MIN_CONTEXT_WINDOW)} and ${String(MAX_CONTEXT_WINDOW)}`);
		if (normalized.has(id)) throw new Error(`Duplicate model id: ${id}`);
		normalized.set(id, rawWindow);
	}
	return Object.fromEntries(normalized);
}
/**
* Lenient boundary: the catalog and any config read where a bad entry must
* never break a request. Invalid ids, non-integers, out-of-range windows,
* duplicates after trimming and oversize dictionaries are dropped, so a
* hand-edited profile patch cannot arm a broken window either.
*/
function sanitizeModelContextWindows(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const sanitized = /* @__PURE__ */ new Map();
	for (const [rawId, rawWindow] of Object.entries(input)) {
		if (sanitized.size >= MAX_MODEL_CONTEXT_WINDOWS) break;
		const id = rawId.trim();
		if (!validModelId(id) || !validWindow(rawWindow) || sanitized.has(id)) continue;
		sanitized.set(id, rawWindow);
	}
	return Object.fromEntries(sanitized);
}
/**
* Editor text -> dictionary. One `model-id = tokens` per line; `:` is accepted
* as the separator too, matching the header editor's muscle memory. Blank
* lines are ignored; a line without a separator, a duplicate id or an invalid
* window throws. Values are plain decimal token counts: `1m` is ambiguous
* (1,000,000 vs 1,048,576), so a suffix is refused rather than guessed.
*/
function parseModelContextWindows(text) {
	const entries = [];
	const ids = /* @__PURE__ */ new Set();
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const equals = line.indexOf("=");
		const colon = line.indexOf(":");
		const separator = equals < 0 ? colon : colon < 0 ? equals : Math.min(equals, colon);
		if (separator <= 0) throw new Error("Use one \"model-id = tokens\" per line");
		const id = line.slice(0, separator).trim();
		const rawValue = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(rawValue)) throw new Error(`Context window for ${id} must be a whole number of tokens`);
		const window$1 = Number(rawValue);
		if (!Number.isSafeInteger(window$1) || window$1 < MIN_CONTEXT_WINDOW || window$1 > MAX_CONTEXT_WINDOW) throw new Error(`Context window for ${id} must be an integer between ${String(MIN_CONTEXT_WINDOW)} and ${String(MAX_CONTEXT_WINDOW)}`);
		if (ids.has(id)) throw new Error(`Duplicate model id: ${id}`);
		ids.add(id);
		entries.push([id, window$1]);
	}
	return normalizeModelContextWindows(Object.fromEntries(entries));
}
/** Dictionary -> editor text (`model-id = tokens`, one per line). */
function formatModelContextWindows(overrides) {
	return Object.entries(overrides).map(([id, window$1]) => `${id} = ${String(window$1)}`).join("\n");
}

//#endregion
//#region src/request-headers.ts
const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
/** Headers the plugin owns: authentication, cookies, framing, body format and
*  the client-identity flag (the wire impersonates the CLI and nothing moves
*  that). */
const MANAGED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"host",
	"connection",
	"proxy-connection",
	"content-length",
	"transfer-encoding",
	"upgrade",
	"trailer",
	"te",
	"expect",
	"content-type",
	"content-encoding",
	"accept-encoding",
	"x-opencode-client"
]);
/** The plugin's own control headers (the relay's `x-oc2dsh-egress`): an
*  override must neither steer the relay nor leak upstream. */
const MANAGED_PREFIX = "x-oc2dsh-";
const MAX_HEADERS = 32;
function isManaged(name) {
	return MANAGED_HEADERS.has(name) || name.startsWith(MANAGED_PREFIX);
}
const MAX_BYTES = 8192;
/** One accepted entry, or undefined when the pair must be dropped. */
function accept(rawName, rawValue) {
	if (typeof rawName !== "string") return void 0;
	const name = rawName.toLowerCase();
	if (!HEADER_NAME.test(name) || isManaged(name)) return void 0;
	if (typeof rawValue !== "string" || !HEADER_VALUE.test(rawValue)) return void 0;
	const value = rawValue.trim();
	if (value === "") return void 0;
	return [name, value];
}
/**
* Strict boundary: the settings editor and any explicit write path. Throws with
* a user-facing message so the card can show why a draft was refused.
*/
function normalizeRequestHeaders(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Request headers must be an object");
	const entries = Object.entries(input);
	if (entries.length > MAX_HEADERS) throw new Error(`At most ${String(MAX_HEADERS)} request headers are allowed`);
	const normalized = /* @__PURE__ */ new Map();
	let size = 0;
	for (const [rawName, rawValue] of entries) {
		const name = rawName.toLowerCase();
		if (!HEADER_NAME.test(name)) throw new Error("Invalid request header name");
		if (isManaged(name)) throw new Error(`Header is managed by the plugin: ${name}`);
		if (normalized.has(name)) throw new Error(`Duplicate request header: ${name}`);
		const pair = accept(rawName, rawValue);
		if (pair === void 0) throw new Error(`Invalid request header value: ${name}`);
		const [, value] = pair;
		size += name.length + value.length + 4;
		if (size > MAX_BYTES) throw new Error(`Request headers must fit within ${String(MAX_BYTES)} bytes`);
		normalized.set(name, value);
	}
	return Object.fromEntries(normalized);
}
/** HTTP-style lines keep colon-containing values intact; blank restores defaults. */
function parseRequestHeaders(text) {
	const entries = [];
	const names = /* @__PURE__ */ new Set();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new Error("Use one Header-Name: value per line");
		const name = line.slice(0, colon).trim().toLowerCase();
		if (names.has(name)) throw new Error(`Duplicate request header: ${name}`);
		names.add(name);
		entries.push([name, line.slice(colon + 1)]);
	}
	return normalizeRequestHeaders(Object.fromEntries(entries));
}
function formatRequestHeaders(headers) {
	return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
}

//#endregion
//#region src/client/settings-writes.ts
/** Header edits live at the entry root, alongside (never inside) ipPool. */
function requestHeadersWriteOps(text, current, base) {
	const write = fieldWrite("requestHeaders", parseRequestHeaders(text), current, base);
	if (!write) return [];
	return [write.op === "unset" ? {
		op: "unset",
		path: ["requestHeaders"]
	} : {
		op: "set",
		path: ["requestHeaders"],
		value: write.value
	}];
}
/** Context-window edits are their own root node too (never inside ipPool). */
function modelContextWriteOps(text, current, base) {
	const write = fieldWrite("modelContextWindows", parseModelContextWindows(text), current, base);
	if (!write) return [];
	return [write.op === "unset" ? {
		op: "unset",
		path: ["modelContextWindows"]
	} : {
		op: "set",
		path: ["modelContextWindows"],
		value: write.value
	}];
}
/** Reverting an override to its inherited value must remove the override. */
function fieldWrite(field, next, current, base) {
	if (JSON.stringify(next) === JSON.stringify(current)) return void 0;
	if (JSON.stringify(next) === JSON.stringify(base)) return {
		field,
		op: "unset"
	};
	return {
		field,
		op: "set",
		value: next
	};
}
/** The usage-scope switch writes immediately, outside the draft save. */
function usageScopeWriteOps(scope) {
	return [{
		op: "set",
		path: ["ipPool", "usageScope"],
		value: scope
	}];
}
/** Keep a pool edit inside its entry and migrate the old flat URL alias. */
function poolWriteOps(writes) {
	return writes.flatMap((write) => {
		const edit = write.op === "unset" ? {
			op: "unset",
			path: ["ipPool", write.field]
		} : {
			op: "set",
			path: ["ipPool", write.field],
			value: write.value
		};
		return write.field === "subscription" ? [edit, {
			op: "unset",
			path: ["ipPool", "subscriptions"]
		}] : [edit];
	});
}

//#endregion
//#region src/client/form-model.ts
/**
* Host schema defaults, spelled as literals: the browser bundle never imports
* a Host module (DEFAULT_SUBSCRIPTION_USER_AGENT in src/pool/subscription.ts
* would drag the YAML parser in).
*/
const DEFAULTS = {
	enabled: false,
	probeModels: [],
	probeContents: [],
	maxConcurrentProbes: 3,
	poolSize: 10,
	manual: [],
	subscription: {
		urls: [],
		refreshMs: 30 * 6e4,
		userAgent: "clash-verge/v2.4.2"
	},
	singbox: { path: "sing-box" },
	pinnedExitId: "",
	pinnedStrict: false,
	proxyHosts: [],
	localFallback: false,
	localIpFamily: "auto",
	usageScope: "total"
};
/** Which group shows each field; null = a top-level row outside every group. */
const FIELD_GROUP = {
	enabled: null,
	localFallback: null,
	localIpFamily: null,
	manual: "sources",
	subscriptionUrls: "sources",
	refreshMs: "sources",
	userAgent: "sources",
	singboxPath: "sources",
	pinnedExitId: "scheduling",
	pinnedStrict: "scheduling",
	probeModels: "probe",
	probeContents: "probe",
	maxConcurrentProbes: "probe",
	poolSize: "probe",
	usageScope: "usage"
};
const FIELDS = Object.keys(FIELD_GROUP);
function emptyForm() {
	return formFromValue(DEFAULTS);
}
function formFromValue(value) {
	return {
		enabled: value.enabled,
		manual: [...value.manual],
		subscriptionUrls: [...value.subscription.urls],
		refreshMs: String(value.subscription.refreshMs),
		userAgent: value.subscription.userAgent,
		singboxPath: value.singbox.path,
		pinnedExitId: value.pinnedExitId,
		pinnedStrict: value.pinnedStrict,
		localFallback: value.localFallback === true,
		localIpFamily: value.localIpFamily === "ipv4" || value.localIpFamily === "ipv6" ? value.localIpFamily : "auto",
		probeModels: [...value.probeModels],
		probeContents: [...value.probeContents ?? []],
		maxConcurrentProbes: String(value.maxConcurrentProbes),
		poolSize: String(value.poolSize ?? DEFAULTS.poolSize),
		usageScope: value.usageScope === "run" ? "run" : "total"
	};
}
/**
* The ip-pool section of the served value, with defaults filled. A missing
* section reads as the documented defaults so the form still renders.
*/
function servedSection(state) {
	const served = (state?.value)?.ipPool;
	const nestedUrls = served?.subscription?.urls ?? [];
	const legacyUrls = served?.subscriptions ?? [];
	return {
		...DEFAULTS,
		...served,
		subscription: {
			...DEFAULTS.subscription,
			...served?.subscription,
			...nestedUrls.length > 0 ? {} : { urls: legacyUrls }
		},
		singbox: {
			...DEFAULTS.singbox,
			...served?.singbox
		}
	};
}
/** The composition-side (base) ip-pool section, for the values a reset returns to. */
function servedBase(state) {
	return servedSection({
		...state,
		value: state?.base
	});
}
/** An empty UA field means the default, so clearing it is not a pending change. */
function normalizedUserAgent(value) {
	const trimmed = value.trim();
	return trimmed === "" ? DEFAULTS.subscription.userAgent : trimmed;
}
/** Field writes landing the form on the resolved value, in write order. */
function diffWrites(form, value, base) {
	const writes = [];
	const push = (field, next, current, baseValue) => {
		const edit = fieldWrite(field, next, current, baseValue);
		if (edit !== void 0) writes.push(edit);
	};
	push("enabled", form.enabled, value.enabled, base.enabled);
	push("manual", form.manual, value.manual, base.manual);
	push("subscription", {
		urls: form.subscriptionUrls,
		refreshMs: Number(form.refreshMs),
		userAgent: normalizedUserAgent(form.userAgent)
	}, value.subscription, base.subscription);
	push("singbox", { path: form.singboxPath }, value.singbox, base.singbox);
	push("pinnedExitId", form.pinnedExitId, value.pinnedExitId, base.pinnedExitId);
	push("pinnedStrict", form.pinnedStrict, value.pinnedStrict, base.pinnedStrict);
	push("localFallback", form.localFallback, value.localFallback, base.localFallback);
	push("localIpFamily", form.localIpFamily, value.localIpFamily, base.localIpFamily);
	push("probeModels", form.probeModels, value.probeModels, base.probeModels);
	push("probeContents", form.probeContents, value.probeContents, base.probeContents);
	push("maxConcurrentProbes", Number(form.maxConcurrentProbes), value.maxConcurrentProbes, base.maxConcurrentProbes);
	push("poolSize", Number(form.poolSize), value.poolSize, base.poolSize);
	push("usageScope", form.usageScope, value.usageScope, base.usageScope);
	return writes;
}
const isInteger = (text) => /^\d+$/.test(text.trim());
/** The first draft problem, or null when the draft can be saved. */
function validateForm(form) {
	const conc = Number(form.maxConcurrentProbes);
	if (!isInteger(form.maxConcurrentProbes) || conc < 1 || conc > 8) return {
		reason: "invalidRange",
		group: "probe"
	};
	const poolSize = Number(form.poolSize);
	if (!isInteger(form.poolSize) || poolSize < 1 || poolSize > 100) return {
		reason: "invalidRange",
		group: "probe"
	};
	const refresh = Number(form.refreshMs);
	if (!isInteger(form.refreshMs) || refresh < 6e4) return {
		reason: "invalidRange",
		group: "sources"
	};
	if (!form.manual.every(isManualProxyEntry)) return {
		reason: "invalidProxy",
		group: "sources"
	};
	if (!form.subscriptionUrls.every((url) => /^https?:\/\/.+/.test(url))) return {
		reason: "invalidUrl",
		group: "sources"
	};
	if (form.probeModels.some((model) => model.trim() === "")) return {
		reason: "invalidModel",
		group: "probe"
	};
	return null;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A pristine draft of the served form (initial load, 丢弃). */
function pristineDraft(served) {
	return {
		draft: served,
		accepted: served,
		conflicts: []
	};
}
/**
* Reconcile the draft with a new served form, field by field: a pristine
* field (draft = last accepted) or one already equal to the new value follows
* it; a dirty field whose served value moved is recorded as a conflict and
* keeps the operator's edit, so a later save can never silently revert it.
*/
function followServed(current, served) {
	if (same(current.accepted, served)) return current;
	const draft = { ...current.draft };
	const conflicts = new Set(current.conflicts);
	for (const field of FIELDS) {
		const mine = current.draft[field];
		if (same(mine, current.accepted[field]) || same(mine, served[field])) {
			draft[field] = served[field];
			conflicts.delete(field);
		} else if (!same(served[field], current.accepted[field])) conflicts.add(field);
	}
	return {
		draft,
		accepted: served,
		conflicts: [...conflicts]
	};
}
/** Conflicts still standing: a field edited back to the served value is resolved. */
function liveConflicts(pool) {
	return pool.conflicts.filter((field) => !same(pool.draft[field], pool.accepted[field]));
}
/**
* Subscription URLs never render in full: the settings document is the only
* place they exist in plaintext. Only scheme and host survive; any path,
* query or credentials (where tokens live) collapse to an ellipsis.
*/
function redactUrl(url) {
	const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#]*)(.*)$/i.exec(url.trim());
	if (match === null) return "…";
	const [, scheme, host, rest] = match;
	return `${scheme}${host}${rest !== "" && rest !== "/" ? "/…" : ""}`;
}

//#endregion
//#region src/client/fields/ListEditor.tsx
/** Stable React keys for a list that may hold duplicates: value plus occurrence. */
function entryKeys(values) {
	const seen = /* @__PURE__ */ new Map();
	return values.map((entry) => {
		const nth = seen.get(entry) ?? 0;
		seen.set(entry, nth + 1);
		return `${nth}:${entry}`;
	});
}
/**
* One editable string list (manual proxies / subscription URLs / probe
* contents): one capsule row per entry with a remove button, then an Input +
* 添加 Button (Enter also adds). A duplicate add is refused with an inline
* note; a fresh add flashes the new row. Removal is by position, so a stored
* duplicate goes one row at a time.
*/
function ListEditor(props) {
	const { label, addLabel, hint, values, placeholder, testId, redacted, disabled, t, onChange } = props;
	const [draft, setDraft] = (0, react.useState)("");
	const [dup, setDup] = (0, react.useState)(false);
	const [fresh, setFresh] = (0, react.useState)(null);
	const freshTimer = (0, react.useRef)(null);
	(0, react.useEffect)(() => () => {
		if (freshTimer.current !== null) clearTimeout(freshTimer.current);
	}, []);
	const add = () => {
		const entry = draft.trim();
		if (entry === "") return;
		if (values.includes(entry)) {
			setDup(true);
			return;
		}
		setDup(false);
		onChange([...values, entry]);
		setDraft("");
		setFresh(entry);
		if (freshTimer.current !== null) clearTimeout(freshTimer.current);
		freshTimer.current = setTimeout(() => setFresh(null), 400);
	};
	const keys = entryKeys(values);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: form_module_css_default.field,
		"data-testid": testId,
		children: [
			label !== void 0 && label !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldHint,
				children: hint
			}),
			values.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: form_module_css_default.listItems,
				children: values.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: entry === fresh ? `${form_module_css_default.listItem} ${form_module_css_default.listItemNew}` : form_module_css_default.listItem,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: form_module_css_default.listItemText,
						children: redacted === true ? redactUrl(entry) : entry
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "sm",
						disabled: disabled === true,
						"aria-label": t("listRemove"),
						title: t("listRemove"),
						onClick: () => {
							setDup(false);
							onChange(values.filter((_, at) => at !== index));
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconCloseFillMedium, {})
					})]
				}, keys[index]))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: form_module_css_default.listAddRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
					className: form_module_css_default.listAddInput,
					value: draft,
					placeholder,
					"aria-label": addLabel ?? label,
					disabled: disabled === true,
					onChange: (event) => {
						setDraft(event.target.value);
						if (dup) setDup(false);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					disabled: disabled === true || draft.trim() === "",
					onClick: add,
					children: t("listAdd")
				})]
			}),
			dup && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.listDup,
				role: "status",
				children: t("listExists")
			})
		]
	});
}

//#endregion
//#region src/client/fields/ModelPicker.tsx
/**
* Probe-model picker over the bridge /models rows: selected models as
* removable chips above a dropdown of the options. Empty selection = the
* S3-first default (big-pickle).
*/
function ModelPicker(props) {
	const { value, hint, models, loading, disabled, t, onChange } = props;
	const [open, setOpen] = (0, react.useState)(false);
	const toggle = (id) => {
		onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);
	};
	const triggerLabel = loading ? t("statusLoading") : models.length === 0 ? "—" : t("probeModelPick");
	const items = models.map((row) => ({
		id: row.id,
		label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [row.id, row.verified === false && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: form_module_css_default.chipSub,
			children: [" · ", t("probeModelUnverified")]
		})] })
	}));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: form_module_css_default.field,
		"data-testid": "field-probeModels",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: t("probeModels")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldHint,
				children: hint
			}),
			value.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: form_module_css_default.chipRow,
				children: value.map((id) => {
					const row = models.find((m) => m.id === id);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: form_module_css_default.chip,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: form_module_css_default.chipText,
							children: [id, row?.verified === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: form_module_css_default.chipSub,
								children: t("probeModelUnverified")
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: disabled === true,
							"aria-label": t("listRemove"),
							title: t("listRemove"),
							onClick: () => toggle(id),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconCloseFillMedium, {})
						})]
					}, id);
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => setOpen(false),
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					"data-testid": "probe-model-select",
					disabled: disabled === true || loading || models.length === 0,
					onClick: () => setOpen((current) => !current),
					children: [triggerLabel, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {})]
				}),
				items,
				selectedIds: value,
				onSelect: (id) => {
					toggle(id);
					setOpen(false);
				},
				align: "start",
				side: "bottom",
				portal: true
			}),
			value.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldHint,
				children: t("probeModelsDefault")
			})
		]
	});
}

//#endregion
//#region src/client/fields/TextField.tsx
/** One labeled input (the Input primitive carries the box chrome). */
function TextField(props) {
	const { label, hint, value, onChange, placeholder, testId, type = "text", min, max, step, invalid, disabled, action, width } = props;
	const widthClass = width === "narrow" ? form_module_css_default.fieldControlNarrow : width === "medium" ? form_module_css_default.fieldControlMedium : void 0;
	const controlClass = [
		form_module_css_default.fieldControl,
		widthClass,
		invalid === true ? form_module_css_default.inputWrapInvalid : void 0
	].filter(Boolean).join(" ");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: form_module_css_default.field,
		children: [
			action == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: label
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: form_module_css_default.fieldHead,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.fieldLabel,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.fieldHeadAction,
					children: action
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
				className: controlClass,
				type,
				value,
				placeholder,
				min,
				max,
				step,
				disabled,
				"data-testid": testId,
				onChange: (event) => onChange(event.target.value)
			}),
			hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldHint,
				children: hint
			})
		]
	});
}

//#endregion
//#region src/client/groups/ProbeGroup.tsx
/** 探活: probe models and contents, concurrency, pool size, 批量探活. */
function ProbeGroup(props) {
	const { form, edit, locked, t, chrome, validation, models, modelsLoading, prober, poolRunning, actionBusy, onProbeAll } = props;
	const rangeInvalid = validation?.group === "probe" && validation.reason === "invalidRange";
	const probing = prober !== void 0 && prober.queued + prober.inFlight > 0;
	const summary = [
		form.probeModels.length === 0 ? t("summaryModelsDefault") : t("summaryModelsCount", { count: String(form.probeModels.length) }),
		form.probeContents.length > 0 ? t("summaryContentsCount", { count: String(form.probeContents.length) }) : "",
		t("summaryConcurrency", { count: form.maxConcurrentProbes }),
		t("summaryCapacity", { count: form.poolSize })
	].filter((part) => part !== "").join(" · ");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
		id: "probe",
		title: t("groupProbe"),
		summary,
		...chrome,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
				value: form.probeModels,
				hint: t("probeModelsHint"),
				models,
				loading: modelsLoading,
				disabled: locked,
				t,
				onChange: (next) => edit({ probeModels: next })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
				label: t("probeContents"),
				hint: t("probeContentsHint"),
				values: form.probeContents,
				placeholder: t("probeContentsPlaceholder"),
				testId: "field-probeContents",
				disabled: locked,
				t,
				onChange: (next) => edit({ probeContents: next })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: form_module_css_default.fieldRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
					label: t("probeConcurrency"),
					hint: t("probeConcurrencyHint"),
					value: form.maxConcurrentProbes,
					testId: "field-maxConcurrentProbes",
					type: "number",
					min: 1,
					max: 8,
					step: 1,
					width: "narrow",
					invalid: rangeInvalid,
					disabled: locked,
					onChange: (value) => edit({ maxConcurrentProbes: value })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
					label: t("poolSize"),
					hint: t("poolSizeHint"),
					value: form.poolSize,
					testId: "field-poolSize",
					type: "number",
					min: 1,
					max: 100,
					step: 1,
					width: "narrow",
					invalid: rangeInvalid,
					disabled: locked,
					onChange: (value) => edit({ poolSize: value })
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "outline",
				size: "sm",
				"data-testid": "probe-all",
				disabled: actionBusy || !poolRunning,
				onClick: onProbeAll,
				children: probing ? t("probeRunning").replace("{done}", String(prober.completed)).replace("{total}", String(prober.enqueued)) : t("probeAll")
			}) })
		]
	});
}

//#endregion
//#region src/client/groups/SchedulingGroup.tsx
/** 调度行为: the pinned exit and the pin mode. */
function SchedulingGroup(props) {
	const { form, edit, locked, t, chrome, saving, onUnpin } = props;
	const summary = form.pinnedExitId !== "" ? t("summaryPinned", { target: form.pinnedExitId }) : `${t("summaryAuto")}${form.pinnedStrict ? ` · ${t("pinnedModeAbsolute")}` : ""}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
		id: "scheduling",
		title: t("groupScheduling"),
		summary,
		...chrome,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
			label: t("pinnedAddress"),
			hint: t("pinnedAddressHint"),
			value: form.pinnedExitId,
			placeholder: t("manualPlaceholder"),
			testId: "field-pinnedExitId",
			width: "medium",
			disabled: locked,
			onChange: (value) => edit({ pinnedExitId: value }),
			action: form.pinnedExitId === "" ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "outline",
				size: "sm",
				"data-testid": "unpin",
				disabled: saving,
				onClick: onUnpin,
				children: t("pinnedUnset")
			})
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: form_module_css_default.field,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.fieldLabel,
					children: t("pinnedStrict")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"data-testid": "field-pinnedStrict",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
						id: "ip-pool-pin-mode",
						value: form.pinnedStrict ? "absolute" : "fallback",
						options: [{
							value: "fallback",
							label: t("pinnedModeFallback")
						}, {
							value: "absolute",
							label: t("pinnedModeAbsolute")
						}],
						label: t("pinnedStrict"),
						disabled: locked,
						onChange: (next) => edit({ pinnedStrict: next === "absolute" })
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.fieldHint,
					children: form.pinnedStrict ? t("pinnedStrictOn") : t("pinnedStrictOff")
				})
			]
		})]
	});
}

//#endregion
//#region src/client/groups/SourcesGroup.tsx
/** 出口来源: manual proxies, subscriptions and their fetch/convert settings. */
function SourcesGroup(props) {
	const { form, edit, locked, t, chrome, validation, subscription, poolRunning, actionBusy, onRefreshSubscriptions } = props;
	const summary = [form.manual.length > 0 ? t("summaryProxies", { count: String(form.manual.length) }) : "", form.subscriptionUrls.length > 0 ? t("summarySubscriptions", { count: String(form.subscriptionUrls.length) }) : ""].filter((part) => part !== "").join(" · ") || t("summaryUnset");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
		id: "sources",
		title: t("groupSources"),
		summary,
		...chrome,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: t("sectionManual")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
				addLabel: t("sectionManual"),
				hint: t("manualHint"),
				values: form.manual,
				placeholder: t("manualPlaceholder"),
				testId: "field-manual",
				disabled: locked,
				t,
				onChange: (next) => edit({ manual: next })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: t("sectionSubscription")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
				addLabel: t("sectionSubscription"),
				hint: t("subscriptionHint"),
				values: form.subscriptionUrls,
				placeholder: t("subscriptionPlaceholder"),
				testId: "field-subscriptions",
				redacted: true,
				disabled: locked,
				t,
				onChange: (next) => edit({ subscriptionUrls: next })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
				label: t("subscriptionRefreshMs"),
				hint: t("subscriptionRefreshMsHint"),
				value: form.refreshMs,
				testId: "field-refreshMs",
				type: "number",
				min: 6e4,
				step: 1,
				width: "medium",
				invalid: validation?.group === "sources" && validation.reason === "invalidRange",
				disabled: locked,
				onChange: (value) => edit({ refreshMs: value }),
				action: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					"data-testid": "refresh-subscriptions",
					disabled: actionBusy || !poolRunning,
					onClick: onRefreshSubscriptions,
					children: t("subscriptionRefreshNow")
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
				label: t("subscriptionUserAgent"),
				hint: t("subscriptionUserAgentHint"),
				value: form.userAgent,
				testId: "field-subscriptionUserAgent",
				width: "medium",
				disabled: locked,
				onChange: (value) => edit({ userAgent: value })
			}),
			subscription != null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: shared_module_css_default.status,
				children: [t("subscriptionStatus", {
					label: t("sectionSubscription"),
					pending: String(subscription.pendingConversion),
					admitted: String(subscription.convertedAdmitted)
				}), subscription.lastError !== "" ? ` · ${subscription.lastError}` : ""]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
				label: t("singboxPath"),
				hint: t("singboxPathHint"),
				value: form.singboxPath,
				testId: "field-singboxPath",
				width: "medium",
				disabled: locked,
				onChange: (value) => edit({ singboxPath: value })
			})
		]
	});
}

//#endregion
//#region src/client/groups/UsageGroup.tsx
/**
* 用量: the usage-scope switch plus the scoped totals. The switch is a view
* switch written immediately by the card, not a draft edit.
*/
function UsageGroup(props) {
	const { scope, usage, disabled, t, chrome, onScope } = props;
	const summary = usage == null ? t("summaryUsageNone") : t("summaryUsage", {
		requests: usage.scoped.requests.toLocaleString(),
		tokens: compact(grandTotal(usage.scoped))
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
		id: "usage",
		title: t("groupUsage"),
		summary,
		...chrome,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			"data-testid": "usage-section",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: form_module_css_default.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"data-testid": "usage-scope",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
						id: "ip-pool-usage-scope",
						value: scope,
						options: [{
							value: "total",
							label: t("usageScopeTotal")
						}, {
							value: "run",
							label: t("usageScopeRun")
						}],
						label: t("usageScopeLabel"),
						disabled,
						onChange: onScope
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.fieldHint,
					children: t("usageScopeHint", { days: String(usage?.retentionDays ?? 90) })
				})]
			}), usage == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: shared_module_css_default.status,
				children: t("usageNoStore")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: shared_module_css_default.statsSummary,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummaryRequests", { count: usage.scoped.requests.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummaryTokens", { count: compact(grandTotal(usage.scoped)) })
					}),
					(usage.recentSpeed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("statsSummarySpeed", { count: (usage.recentSpeed ?? 0).toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("usageSummarySessions", { count: usage.sessions.length.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: shared_module_css_default.statsChip,
						children: t("usageSummaryDays", { count: usage.days.length.toLocaleString() })
					})
				]
			})]
		})
	});
}

//#endregion
//#region src/client/ModelContextEditor.tsx
/**
* 模型上下文 editor body — no section chrome of its own: the collapsible
* 「模型上下文」 group supplies the title, so this renders only the field, its
* hint and the saved-entry count.
*/
function ModelContextEditor(props) {
	const { text, disabled, t, onChange } = props;
	const count = text.split("\n").filter((line) => line.trim() !== "").length;
	const hintId = (0, react.useId)();
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
			className: form_module_css_default.field,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: t("modelContextLabel")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: form_module_css_default.textarea,
				"data-testid": "field-modelContextWindows",
				"aria-describedby": hintId,
				rows: 4,
				spellCheck: false,
				disabled,
				value: text,
				placeholder: "mimo-v2.6-flash-free = 1048576\nbig-pickle = 1048576",
				onChange: (event) => onChange(event.target.value)
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			id: hintId,
			className: form_module_css_default.fieldHint,
			children: t("modelContextHint")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: shared_module_css_default.status,
			"data-testid": "model-context-count",
			children: t("modelContextCount", { count: String(count) })
		})
	] });
}

//#endregion
//#region src/client/OverviewBar.tsx
/** Pool overview strip: counts plus deferred / pinned / pin-skipped badges. */
function OverviewBar(props) {
	const { status, t } = props;
	if (status === null) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: form_module_css_default.overviewBar,
		"data-testid": "ip-pool-overview",
		children: [
			status.deferredReason !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: "danger",
				children: t("deferredNotice").replace("{reason}", status.deferredReason)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolAvailable").replace("{available}", String(status.availableTotal)).replace("{total}", String(status.total)).replace("{poolSize}", String(status.poolSize)) }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolSources").replace("{manual}", String(status.bySource.manual)).replace("{subscription}", String(status.bySource.subscription)) }),
			status.pinned !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: "info",
				children: [status.pinned.local === true ? t("pinnedBadgeLocal") : t("pinnedBadge"), status.pinned.strict && status.pinned.local !== true ? " (" + t("pinnedStrict") + ")" : ""]
			}),
			status.pinned !== null && status.pinned.local !== true && status.pinnedSkip != null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: "danger",
				children: t(status.pinnedSkip === "dead" ? "pinnedSkipDead" : "pinnedSkipCooling").replace("{id}", status.pinned.id)
			})
		]
	});
}

//#endregion
//#region src/client/RequestHeadersEditor.tsx
/**
* Zen headers editor body — no section chrome of its own: the collapsible
* 「Zen 请求头」 group supplies the title, so this renders only the field,
* its hint and the effective-UA readout.
*/
function RequestHeadersEditor(props) {
	const { text, effectiveUserAgent, disabled, t, onChange } = props;
	const hintId = (0, react.useId)();
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
			className: form_module_css_default.field,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: form_module_css_default.fieldLabel,
				children: t("requestHeadersLabel")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: form_module_css_default.textarea,
				"data-testid": "field-requestHeaders",
				"aria-describedby": hintId,
				rows: 4,
				spellCheck: false,
				disabled,
				value: text,
				placeholder: "User-Agent: opencode/latest/2.2.0/cli",
				onChange: (event) => onChange(event.target.value)
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			id: hintId,
			className: form_module_css_default.fieldHint,
			children: t("requestHeadersHint")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			className: shared_module_css_default.status,
			"data-testid": "zen-effective-user-agent",
			"aria-live": "polite",
			children: [
				t("requestHeadersEffectiveUA"),
				" ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
					className: form_module_css_default.headerValue,
					children: effectiveUserAgent ?? t("statusLoading")
				})
			]
		})
	] });
}

//#endregion
//#region src/client/IpPoolCard.tsx
/** Copy of the form chrome (the shared SettingsForm labels). */
const formLabels = (t) => ({
	unavailable: t("statusUnavailable"),
	readOnly: t("readOnly"),
	saveFailed: t("saveError"),
	save: t("save"),
	saving: t("saving")
});
/** The label each draft field carries on the page, for the conflict message. */
const FIELD_LABEL = {
	enabled: "enabled",
	localFallback: "localFallback",
	localIpFamily: "localIpFamily",
	manual: "sectionManual",
	subscriptionUrls: "sectionSubscription",
	refreshMs: "subscriptionRefreshMs",
	userAgent: "subscriptionUserAgent",
	singboxPath: "singboxPath",
	pinnedExitId: "pinnedAddress",
	pinnedStrict: "pinnedStrict",
	probeModels: "probeModels",
	probeContents: "probeContents",
	maxConcurrentProbes: "probeConcurrency",
	poolSize: "poolSize",
	usageScope: "usageScopeLabel"
};
/** The card body. */
function CardBody(props) {
	const { settings, t } = props;
	const snapshot = settings?.state;
	const ready = snapshot?.status === "ready";
	const [pool, setPool] = (0, react.useState)(() => pristineDraft(emptyForm()));
	const form = pool.draft;
	const [headersText, setHeadersText] = (0, react.useState)("");
	const [contextText, setContextText] = (0, react.useState)("");
	const [headerConflict, setHeaderConflict] = (0, react.useState)(false);
	const acceptedHeadersRef = (0, react.useRef)("");
	const contextHydratedRef = (0, react.useRef)(false);
	const [saving, setSaving] = (0, react.useState)(false);
	const [saved, setSaved] = (0, react.useState)(false);
	/** The last save's failure: the only error that flips the SettingsForm chrome. */
	const [error, setError] = (0, react.useState)(null);
	/** The last bridge action's failure or warning, shown inline. */
	const [actionError, setActionError] = (0, react.useState)(null);
	const [probeModelRows, setProbeModelRows] = (0, react.useState)([]);
	const [probeModelsLoading, setProbeModelsLoading] = (0, react.useState)(false);
	const [actionBusy, setActionBusy] = (0, react.useState)(false);
	const [groups, setGroups] = (0, react.useState)(() => loadGroupState());
	const [highlightGroup, setHighlightGroup] = (0, react.useState)(null);
	const highlightTimer = (0, react.useRef)(null);
	const { status, error: statusError, refresh } = usePoolStatus((current) => !ready ? null : current !== null && current.prober.queued + current.prober.inFlight > 0 ? 1e3 : 3e3);
	/** The pool runtime is running: what the bridge actions and the exit views need. */
	const poolRunning = status?.enabled === true;
	(0, react.useEffect)(() => {
		try {
			localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groups));
		} catch {}
	}, [groups]);
	(0, react.useEffect)(() => () => {
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
	}, []);
	const served = servedSection(snapshot);
	const servedForm = (0, react.useMemo)(() => formFromValue(servedSection(snapshot)), [snapshot?.value]);
	(0, react.useEffect)(() => {
		if (!ready) return;
		setPool((current) => followServed(current, servedForm));
		if (!contextHydratedRef.current) {
			contextHydratedRef.current = true;
			setContextText(formatModelContextWindows(sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {})));
		}
	}, [ready, servedForm]);
	(0, react.useEffect)(() => {
		if (snapshot?.status !== "ready") return;
		const next = formatRequestHeaders(normalizeRequestHeaders(snapshot.value?.requestHeaders ?? {}));
		let draft = headersText;
		try {
			draft = formatRequestHeaders(parseRequestHeaders(headersText));
		} catch {}
		if (headersText === acceptedHeadersRef.current || draft === next) {
			acceptedHeadersRef.current = next;
			setHeadersText(next);
			setHeaderConflict(false);
		} else if (next !== acceptedHeadersRef.current) setHeaderConflict(true);
	}, [snapshot?.status, snapshot?.value]);
	(0, react.useEffect)(() => {
		let cancelled = false;
		setProbeModelsLoading(true);
		postBridge("/models").then((reply) => {
			if (cancelled) return;
			if (reply.ok && reply.value != null) setProbeModelRows(reply.value.models);
			setProbeModelsLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const conflicts = liveConflicts(pool);
	const writes = diffWrites(form, served, servedBase(snapshot));
	let headerOps = [];
	let headerFailure = headerConflict ? {
		message: t("requestHeadersConflict"),
		group: "headers"
	} : null;
	try {
		headerOps = requestHeadersWriteOps(headersText, normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}), normalizeRequestHeaders((snapshot?.base)?.requestHeaders ?? {}));
	} catch {
		headerFailure = {
			message: t("requestHeadersInvalid"),
			group: "headers"
		};
	}
	const conflictFailure = conflicts.length === 0 ? null : {
		message: t("poolConflict", { field: conflicts.map((field) => t(FIELD_LABEL[field])).join(" · ") }),
		group: FIELD_GROUP[conflicts[0]]
	};
	let contextOps = [];
	let contextFailure = null;
	try {
		contextOps = modelContextWriteOps(contextText, sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {}), sanitizeModelContextWindows((snapshot?.base)?.modelContextWindows ?? {}));
	} catch {
		contextFailure = {
			message: t("modelContextInvalid"),
			group: "models"
		};
	}
	const formFailure = validateForm(form);
	const blocker = headerFailure ?? conflictFailure ?? contextFailure;
	/** The field-level failure, only while it is the one on screen. */
	const shownFormFailure = blocker === null ? formFailure : null;
	const validation = blocker ?? (formFailure === null ? null : {
		message: t(formFailure.reason),
		group: formFailure.group
	});
	const dirty = writes.length > 0 || headerOps.length > 0 || contextOps.length > 0 || validation !== null;
	const available = ready && settings !== void 0;
	const writable = available && snapshot.writable;
	const locked = !writable || saving;
	(0, react.useEffect)(() => {
		const group = validation?.group;
		if (group == null) return;
		setGroups((current) => current[group] ? current : {
			...current,
			[group]: true
		});
		setHighlightGroup(group);
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
		highlightTimer.current = setTimeout(() => setHighlightGroup(null), 1200);
	}, [validation?.group, validation?.message]);
	if (snapshot?.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		className: shared_module_css_default.status,
		children: t("statusLoading")
	});
	/** Patch the draft; any edit retires the saved note. */
	const edit = (patch) => {
		setSaved(false);
		setPool((current) => ({
			...current,
			draft: {
				...current.draft,
				...patch
			}
		}));
	};
	const chrome = (group) => ({
		open: groups[group],
		highlight: highlightGroup === group,
		onToggle: () => setGroups((current) => ({
			...current,
			[group]: !current[group]
		}))
	});
	const handleSave = async () => {
		if (!writable || validation !== null || settings === void 0 || snapshot === void 0) {
			setSaved(false);
			setError(validation?.message ?? t("saveError"));
			return;
		}
		if (writes.length === 0 && headerOps.length === 0 && contextOps.length === 0) {
			setSaved(true);
			setError(null);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const ok = await settings.mutate([
				...headerOps,
				...contextOps,
				...poolWriteOps(writes)
			], snapshot.revision);
			setSaved(ok);
			setError(ok ? null : t("saveError"));
			if (ok && headerOps.length > 0) await refresh();
		} catch (err) {
			setSaved(false);
			setError(err instanceof Error ? err.message : t("saveError"));
		} finally {
			setSaving(false);
		}
	};
	/** The shared SettingsForm discard: drop the draft, keep the served values. */
	const handleDiscard = () => {
		setPool(pristineDraft(servedForm));
		const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}));
		acceptedHeadersRef.current = headers;
		setHeadersText(headers);
		setContextText(formatModelContextWindows(sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {})));
		setHeaderConflict(false);
		setSaved(false);
		setError(null);
		setActionError(null);
	};
	const shell = {
		available,
		writable,
		dirty,
		invalid: validation !== null,
		saving,
		failed: error !== null
	};
	/**
	* Run one bridge action, report a failure (the host's own message when it
	* has one) or a warning, then re-read /status. Returns the reply.
	*/
	const runAction = async (send, warn) => {
		setActionBusy(true);
		setActionError(null);
		try {
			const reply = await send();
			if (!reply.ok) setActionError(bridgeErrorText(reply, t("statsActionFailed")));
			else if (warn !== void 0 && reply.value != null) setActionError(warn(reply.value));
			await refresh();
			return reply;
		} finally {
			setActionBusy(false);
		}
	};
	const probe = (scope) => {
		runAction(() => probeAction(scope));
	};
	/** A read-only profile still pins live; the pin is lost on restart. */
	const volatile = (value) => value.persisted === false ? t("statsActionVolatile") : null;
	/** Pin from the table through the bridge, which checks the listener first. */
	const pinExit = (exitId) => {
		runAction(() => exitAction("pin", exitId), volatile);
	};
	/**
	* 解除固定. With the pool running the bridge unpins live and persists; with
	* it off there is nothing live to unpin, so the field is cleared in the
	* draft and lands on save.
	*/
	const unpin = async () => {
		if (!poolRunning) {
			edit({ pinnedExitId: "" });
			return;
		}
		if ((await runAction(() => exitAction("unpin"), volatile)).ok) edit({ pinnedExitId: "" });
	};
	/** 轮换: the bridge promotes a reserve into the slot or sinks the row. */
	const rotateExit = (exitId) => {
		runAction(() => exitAction("rotate", exitId), (value) => value.busy === true ? t("statsActionBusy") : null);
	};
	/**
	* Switch the usage scope, written IMMEDIATELY: it is a view switch whose
	* numbers come from the bridge, not a configuration edit to save later.
	*/
	const setUsageScope = async (next) => {
		if (!writable || settings === void 0 || snapshot === void 0) return;
		setActionBusy(true);
		setActionError(null);
		try {
			if (!await settings.mutate(usageScopeWriteOps(next), snapshot.revision)) throw new Error(t("saveError"));
			setPool((current) => ({
				...current,
				draft: {
					...current.draft,
					usageScope: next
				}
			}));
			await refresh();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : t("saveError"));
		} finally {
			setActionBusy(false);
		}
	};
	const headersLineCount = headersText.split("\n").filter((line) => line.trim() !== "").length;
	const headersSummary = headersLineCount === 0 ? t("summaryHeadersDefault") : t("summaryHeadersCustom", { count: String(headersLineCount) });
	const contextLineCount = contextText.split("\n").filter((line) => line.trim() !== "").length;
	const contextSummary = contextLineCount === 0 ? t("summaryContextDefault") : t("summaryContextCustom", { count: String(contextLineCount) });
	const exitsSummary = status === null ? t("summaryUnset") : t("footerUsable", {
		usable: String(status.availableTotal),
		total: String(status.total)
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
		labels: formLabels(t),
		state: shell,
		onSave: () => {
			handleSave();
		},
		onDiscard: handleDiscard,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: form_module_css_default.body,
			"data-testid": "ip-pool-form",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: form_module_css_default.settingRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: form_module_css_default.settingRowControl,
						"data-testid": "field-enabled",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: form.enabled,
							label: t("enabled"),
							disabled: locked,
							onChange: (next) => edit({ enabled: next })
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: form_module_css_default.settingRowText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.settingRowTitle,
							children: t("enabled")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.fieldHint,
							children: t("enabledHint")
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverviewBar, {
					status: poolRunning ? status : null,
					t
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: form_module_css_default.settingRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: form_module_css_default.settingRowControl,
						"data-testid": "field-localFallback",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: form.localFallback,
							label: t("localFallback"),
							disabled: locked,
							onChange: (next) => edit({ localFallback: next })
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: form_module_css_default.settingRowText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.settingRowTitle,
							children: t("localFallback")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.fieldHint,
							children: t("localFallbackHint")
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: form_module_css_default.settingRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: form_module_css_default.settingRowControl,
						"data-testid": "field-localIpFamily",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalFamilyPicker, {
							value: form.localIpFamily,
							disabled: locked,
							t,
							onChange: (next) => edit({ localIpFamily: next })
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: form_module_css_default.settingRowText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.settingRowTitle,
							children: t("localIpFamily")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: form_module_css_default.fieldHint,
							children: t("localIpFamilyHint")
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourcesGroup, {
					form,
					edit,
					locked,
					t,
					chrome: chrome("sources"),
					validation: shownFormFailure,
					subscription: status?.subscription,
					poolRunning,
					actionBusy,
					onRefreshSubscriptions: () => probe({ scope: "subscription" })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SchedulingGroup, {
					form,
					edit,
					locked,
					t,
					chrome: chrome("scheduling"),
					saving: saving || actionBusy,
					onUnpin: () => {
						unpin();
					}
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeGroup, {
					form,
					edit,
					locked,
					t,
					chrome: chrome("probe"),
					validation: shownFormFailure,
					models: probeModelRows,
					modelsLoading: probeModelsLoading,
					prober: status?.prober,
					poolRunning,
					actionBusy,
					onProbeAll: () => probe({ scope: "all" })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageGroup, {
					scope: form.usageScope,
					usage: status?.usage,
					disabled: actionBusy || !writable,
					t,
					chrome: chrome("usage"),
					onScope: (next) => {
						setUsageScope(next);
					}
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "headers",
					title: t("groupHeaders"),
					summary: headersSummary,
					...chrome("headers"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RequestHeadersEditor, {
						text: headersText,
						effectiveUserAgent: status?.zenUserAgent,
						disabled: locked,
						t,
						onChange: (text) => {
							setSaved(false);
							setHeadersText(text);
						}
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "models",
					title: t("groupModels"),
					summary: contextSummary,
					...chrome("models"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelContextEditor, {
						text: contextText,
						disabled: locked,
						t,
						onChange: (text) => {
							setSaved(false);
							setContextText(text);
						}
					})
				}),
				poolRunning && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "exits",
					title: t("groupExits"),
					summary: exitsSummary,
					...chrome("exits"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExitTable, {
						status,
						t,
						busy: actionBusy,
						onProbe: (id) => probe({
							scope: "exit",
							exitId: id
						}),
						onPin: pinExit,
						onRotate: rotateExit
					})
				}),
				validation !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					className: form_module_css_default.saveStatusError,
					children: validation.message
				}),
				actionError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "status",
					className: form_module_css_default.saveStatusError,
					"data-testid": "action-error",
					children: actionError
				}),
				statusError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: form_module_css_default.saveStatusError,
					children: t("refreshError")
				}),
				saved && error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `${form_module_css_default.saveStatus} ${form_module_css_default.saveStatusOk}`,
					children: t("saved")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: form_module_css_default.compliance,
					children: t("copyCompliance")
				})
			]
		})
	});
}
/**
* The IP 池 page on the Plugins page. The page owns the card chrome and the
* save control: `view: 'summary'` returns the one-liner under the entry
* title, `view: 'page'` the form bound to the entry's served settings.
*/
function IpPoolCard(props) {
	const { form, t, view } = props;
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: t("description") });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardBody, {
		settings: form,
		t
	});
}
/**
* A `plugins.bundle.config` entry bound to one settings controller. The DSH
* 0.2 bundle page hands its slot NO `form`, so the registration closes over
* the settings provider's controller for the served entry and subscribes here
* (getSnapshot is stable until the next acceptance; subscribe fires on
* replacements).
*/
function bundleConfigCard(controller) {
	return function BundleConfigCard(props) {
		const { view, t } = props;
		const snapshot = (0, react.useSyncExternalStore)((0, react.useCallback)((listener) => controller.subscribe(listener), [controller]), (0, react.useCallback)(() => controller.getSnapshot(), [controller]));
		const form = (0, react.useMemo)(() => ({
			state: snapshot,
			mutate: (ops, expectedRevision) => controller.mutate(ops, expectedRevision)
		}), [controller, snapshot]);
		if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: t("description") });
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardBody, {
			settings: form,
			t
		});
	};
}

//#endregion
//#region src/client/locales.ts
/**
* The `settings.ip-pool` locale dictionaries for the IP 池 card (docs/ip-pool.md
* §5.2 block table). Keys track exactly the UI-surfaced strings.
*/
/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
	requestHeadersLabel: "自定义请求头",
	requestHeadersHint: "每行一个 Header-Name: value，例如 User-Agent。保存后对下一次正式对话、模型列表和准入探测生效，与 IP 池开关无关；留空恢复 profile 中的 userAgent 或插件默认值。鉴权、Cookie、传输头和客户端标识由插件管理。",
	requestHeadersEffectiveUA: "当前生效的 Zen User-Agent：",
	requestHeadersConflict: "请求头已在其他页面更新。请先丢弃本页修改以加载最新值，再重新编辑。",
	requestHeadersInvalid: "请求头格式无效。请每行填写 Header-Name: 非空值，勿重复名称或填写鉴权、Cookie、传输头、客户端标识；最多 32 个，总长不超过 8192 字节。",
	modelContextLabel: "上下文长度覆盖",
	modelContextHint: "每行一个「模型 ID = 上下文长度（token）」，例如 mimo-v2.6-flash-free = 1048576；也接受冒号分隔。保存后对下一次请求生效，无需重启；留空使用 models.dev 的声明值（内置仍覆盖 mimo-v2.6-flash-free = 1048576）。范围 1024–16777216，不要小于该模型的最大输出 token，否则压缩策略腾不出空间。",
	modelContextCount: "已覆盖 {count} 个模型",
	modelContextInvalid: "模型上下文格式无效。请每行填写「模型 ID = 整数」，范围 1024–16777216，最多 128 个模型，且不要重复。",
	title: "IP 池（oc2dsh）",
	description: "多出口调度免费模型的可用性：出口间自动轮换、429 冷却、按出口×模型探活。",
	statusLoading: "加载中…",
	statusUnavailable: "设置服务不可用，无法读写 IP 池配置。",
	enabled: "启用 IP 池",
	enabledHint: "关闭后全部流量直连，行为与本插件未装 IP 池时完全一致。",
	localFallback: "本地出口兜底",
	localFallbackHint: "开：池里没有可用 IP 时退回本机直连（会暴露本机 IP）。关（默认）：池里没有可用 IP 时请求直接失败，不会用本机 IP 出口；在弹窗里手动固定「本机」仍然生效。",
	localIpFamily: "本机出口协议族",
	localIpFamilyHint: "本机出口（固定「本机」或本地兜底）用哪个 IP 协议族。默认「自动」：本机有可用 IPv6 时优先 IPv6，连不上再回退 IPv4 —— 与官方客户端一致；免费车道拒绝本机 IPv4、接受本机 IPv6。仅 IPv4 / 仅 IPv6 为强制指定，不做回退。",
	localIpFamilyAuto: "自动（优先 IPv6）",
	localIpFamilyIpv4: "仅 IPv4",
	localIpFamilyIpv6: "仅 IPv6",
	poolAvailable: "池可用 {available}/{total}（容量 {poolSize}）",
	poolSources: "出口来源：手填 {manual} · 订阅 {subscription}",
	pinnedBadge: "固定主力",
	pinnedBadgeLocal: "固定本机（直连）",
	pinnedSkipDead: "固定主力 {id} 已 dead，请求正改走其他出口",
	pinnedSkipCooling: "固定主力 {id} 冷却中，请求正改走其他出口",
	deferredNotice: "路由已退避：{reason}",
	sectionManual: "手填代理",
	manualHint: "一行一个 [协议://]host:port：协议可省略（默认 http），可选 http、https、socks4、socks5、socks5h；IPv6 地址写在方括号里，例如 socks5://[::1]:1080；不支持账号密码。适合自备节点/专线。",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "订阅",
	subscriptionHint: "机场/自建 Clash·V2ray 订阅 URL，一行一个；明文节点直拨，加密节点经 sing-box 转换。",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "刷新间隔（毫秒）",
	subscriptionRefreshMsHint: "默认 1,800,000（30 分钟）。订阅只低频拉取，绝不并发轰炸。",
	subscriptionRefreshNow: "立即刷新",
	subscriptionStatus: "{label}：{pending} 待转换 · {admitted} 已转换入池",
	subscriptionUserAgent: "拉取 UA",
	subscriptionUserAgentHint: "拉订阅时发送的 User-Agent。机场常按它做白名单（不在名单里会返回错误页或 502），有的还按它决定返回哪种格式：Clash 形状给 YAML，v2ray 形状给 base64 链接。留空 = 内置默认值。",
	singboxPath: "sing-box 路径",
	singboxPathHint: "加密节点的转换核心：PATH 名或绝对路径。未装则加密节点停在「待转换」。",
	pinnedAddress: "主力出口地址",
	pinnedAddressHint: "例如 Clash 混合端口 http://127.0.0.1:7897，或专线 http://host:port。即填即固定；填 local = 固定本机（直连，不走任何出口）。",
	pinnedStrict: "绝对固定",
	pinnedStrictOn: "绝对固定：失败也不换、不直连",
	pinnedStrictOff: "主力+备胎：429/断线自动切换，恢复后回归",
	pinnedUnset: "解除固定",
	probeModels: "探活模型",
	probeModelsHint: "从列表选择探活模型；不选 = 默认 big-pickle。同一出口内多模型串行探测。",
	probeModelPick: "选择模型…",
	probeModelUnverified: "未验证",
	probeModelsDefault: "当前使用默认探活模型：big-pickle（S3 已验证清单首个）。",
	probeContents: "探测文案",
	probeContentsHint: "冒烟探测发给上游的那句话：每个出口每次探测随机挑一条（同一出口本轮多模型共用）；留空 = 默认 hello。",
	probeContentsPlaceholder: "例如：hello",
	poolSize: "池子容量",
	poolSizeHint: "同时在线的出口数（1-100，默认 10）：上线时先测速，取最快的前 N 个，并把 sing-box 本地监听收缩到它们（池子之外的节点留作候补）。",
	probeConcurrency: "并发上限",
	probeConcurrencyHint: "不同出口并发探测的上限（1-8，默认 3）；同一出口永远串行。",
	probeAll: "批量探活",
	probeRunning: "探活中 {done}/{total}…",
	exitAddress: "地址",
	exitSource: "来源",
	exitLatency: "延迟",
	exitQuality: "质量",
	exitIp: "出口 IP",
	exitState: "状态",
	exitPassive: "真实流量",
	exitPassiveLabel: "成功 {ok} · 429 限流 {limited} · 401/403 拒绝 {refused} · 失败 {failed}",
	stateOk: "ok",
	stateCooling: "冷却中",
	stateAbusive: "IP 被判滥用",
	stateDead: "dead",
	stateUnknown: "未探活",
	stateDemoted: "已降级",
	exitProbe: "探测",
	exitPin: "固定为主力",
	exitPinnedMark: "主力",
	sectionBans: "模型封禁列表",
	bansEmpty: "没有已封禁的 (出口 × 模型) 对。",
	banBanned: "已封禁",
	banSuspect: "疑似",
	copyCompliance: "匿名配额受上游限流；多出口不绕过配额，只在出口间调度。",
	footerLabel: "出口",
	footerTitle: "IP 池出口统计",
	footerUsable: "可用 {usable}/{total}",
	footerRequests: "{count} 请求",
	footerSpeed: "{count} tok/s",
	footerDisabled: "IP 池未启用",
	footerLocal: "本地直连",
	statsTitle: "数据统计",
	statsDescription: "请求数为本次进程内累计；token 随设置页的「用量口径」切换（默认总览 = 持久台账，重启不清零）。总数 = 输入 + 输出 + 缓存读写；点击表头排序，默认按请求数降序。",
	statsStale: "刷新失败，下面是 {time} 的数据。",
	statsDescriptionUsage: "持久用量台账：重启不清零，保留 {days} 天；「清空统计」会同时抹掉总量、每天、会话与出口四个视图。",
	statsTabsLabel: "数据统计视图切换",
	statsClose: "关闭",
	statsSummaryRequests: "请求 {count}",
	statsSummaryTokens: "Token {count}",
	statsSummarySpeed: "输出 {count} tok/s",
	statsSpeedNote: "{count} tok/s",
	statsSummaryInflight: "在途 {count}",
	statsSummaryLocal: "本机 {count}",
	statsSummaryDirect: "直连兜底 {count} 次",
	statsColIp: "出口 IP",
	statsColRegion: "地区",
	statsColState: "状态",
	statsColRequests: "请求数",
	statsColInput: "输入",
	statsColOutput: "输出",
	statsColCache: "缓存",
	statsColLatency: "延迟",
	statsColLastUsed: "最后使用",
	statsColActions: "操作",
	statsStateUsable: "可用",
	statsStateUnverified: "未验证",
	tabExits: "出口",
	tabUsage: "流量",
	usageScopeLabel: "用量口径",
	usageScopeTotal: "总览（累计）",
	usageScopeRun: "本次重启",
	usageScopeHint: "总览 = 持久记录，重启不丢，按天保留 {days} 天；本次重启 = 当前进程。左下角入口的 token 固定显示当天用量；出口列表里的用量数字随这里切换。",
	usageSummarySessions: "会话 {count}",
	usageSummaryDays: "活跃 {count} 天",
	usageRequestsShort: "{count} 次",
	usageDailyTitle: "每天",
	usageDailyEmpty: "还没有按天记录。",
	usageTopSessions: "Top 会话",
	usageBreakdownTitle: "会话与项目分布",
	usageSessionsEmpty: "还没有按会话记录。",
	usageColSession: "会话",
	usageColProject: "项目",
	usageColTokens: "Token",
	usageProjectsTitle: "项目",
	usageProjectMeta: "{sessions} 会话 · {tokens} tok · {requests} 次",
	usageUnlabeled: "（无首轮内容的会话）",
	usageFootnote: "持久记录：{sessions} 个会话 / {days} 天，按天保留 {retention} 天；总量累计到手动清空为止。",
	usageNoStore: "本机没有启用持久记录（旧版宿主或数据目录不可写）。",
	usageClear: "清空统计",
	usageClearHint: "清空台账：总量、每天、会话、出口全部归零并写入磁盘（重启也不会回来）。",
	usageClearConfirm: "确认清空全部统计？总量与本次重启都会归零。",
	usageClearYes: "确认清空",
	usageClearCancel: "取消",
	usageCleared: "统计已清空",
	statsLocalIp: "本机",
	statsLocalState: "直连",
	statsPin: "固定",
	statsUnpin: "取消固定",
	statsRotate: "轮换",
	statsPinHint: "固定：后续流量固定走该出口",
	statsUnpinHint: "取消固定：回到自动轮换",
	statsPinLocalHint: "固定本机：所有流量直连，不走任何出口",
	statsRotateHint: "轮换：从候选池补一个新地址；没有候补则移到列表末尾",
	statsActionPinned: "已固定到该出口",
	statsActionPinnedLocal: "已固定到本机（直连）",
	statsActionUnpinned: "已取消固定",
	statsActionReplaced: "已轮换：候补已补位",
	statsActionDemoted: "已轮换：暂无候补，已移到列表末尾",
	statsActionBusy: "轮换进行中，请稍后重试",
	statsActionVolatile: "已生效，但未写入配置（重启后失效）",
	statsActionFailed: "操作失败",
	statsRefreshSubscriptionsHint: "立即刷新：重新拉取订阅并转换入池，与配置页的「立即刷新」一致。",
	statsSubscriptionRefreshed: "订阅已刷新",
	statsInflight: "在途×{count}",
	statsNever: "—",
	statsEmpty: "暂无出口数据：IP 池未启用或尚未准入出口。",
	statsPoolOff: "IP 池已关闭：没有流量经过出口，下面只统计本机（直连）流量。",
	statsPoolDeferred: "IP 池已开启，但路由层退避了：{reason}。请求暂时从本机直连，下面只统计本机流量。",
	statsPoolNotReady: "IP 池开关是开的，但运行时没有装配起来（ip-pool 初始化失败，详情见 ~/.dsh/oc2dsh/adapter-status.json 的 pool.wiringError）。",
	statsError: "统计获取失败",
	save: "保存",
	saving: "保存中…",
	saved: "已保存，立即生效",
	saveError: "保存失败",
	readOnly: "当前配置为只读，无法保存修改。",
	invalidRange: "数值超出允许范围。",
	invalidProxy: "代理地址格式应为 [协议://]host:port（协议可选 http、https、socks4、socks5、socks5h；IPv6 写在方括号里；不支持账号密码）。",
	invalidUrl: "请填写合法的 http(s) URL。",
	invalidModel: "模型 id 不能为空。",
	refreshError: "状态获取失败",
	poolConflict: "「{field}」已在别处更新（统计弹窗或其他标签页）。请先丢弃本页修改以加载最新值，再重新编辑。",
	groupSources: "出口来源",
	groupScheduling: "调度行为",
	groupProbe: "探活",
	groupUsage: "用量",
	groupHeaders: "Zen 请求头",
	groupModels: "模型上下文",
	groupExits: "出口列表",
	summaryUnset: "未配置",
	summaryProxies: "{count} 个代理",
	summarySubscriptions: "{count} 个订阅",
	summaryAuto: "自动轮换",
	summaryPinned: "已固定 {target}",
	summaryModelsDefault: "默认模型",
	summaryModelsCount: "{count} 个模型",
	summaryContentsCount: "{count} 条文案",
	summaryConcurrency: "并发 {count}",
	summaryCapacity: "容量 {count}",
	summaryUsage: "{requests} 请求 · {tokens} tok",
	summaryUsageNone: "暂无记录",
	summaryHeadersDefault: "使用内置默认",
	summaryHeadersCustom: "自定义 {count} 条",
	summaryContextDefault: "使用 models.dev 声明值",
	summaryContextCustom: "已覆盖 {count} 个模型",
	pinnedModeFallback: "主力+备胎",
	pinnedModeAbsolute: "绝对固定",
	listAdd: "添加",
	listExists: "该项已存在",
	listRemove: "移除"
};
/** English dictionary, checked complete against the zh key set. */
const en = {
	requestHeadersLabel: "Custom request headers",
	requestHeadersHint: "One Header-Name: value per line, e.g. User-Agent. Applies to the next chat, model-list refresh and admission probe, regardless of the IP pool switch. Leave blank to use the profile userAgent or built-in default. Authentication, cookies, transport headers and the client-identity flag are managed by the plugin.",
	requestHeadersEffectiveUA: "Effective Zen User-Agent:",
	requestHeadersConflict: "Request headers changed elsewhere. Discard this draft to load the latest values, then edit again.",
	requestHeadersInvalid: "Invalid headers. Use one Header-Name: non-empty value per line, without duplicate names, authentication, cookies, transport headers or the client-identity flag. Maximum 32 headers and 8192 bytes in total.",
	modelContextLabel: "Context window overrides",
	modelContextHint: "One \"model-id = context window (tokens)\" per line, e.g. mimo-v2.6-flash-free = 1048576; a colon separator works too. Applies to the next request without a restart; leave blank to use the models.dev declaration (the built-in mimo-v2.6-flash-free = 1048576 override still applies). Range 1024–16777216; do not go below the model's max output tokens or compaction will have no room to work.",
	modelContextCount: "{count} models overridden",
	modelContextInvalid: "Invalid model context windows. Use one \"model-id = integer\" per line, range 1024–16777216, at most 128 models, without duplicates.",
	title: "IP Pool (oc2dsh)",
	description: "Schedules free-model availability across exit IPs: rotation, 429 cooldown, per-exit×model probes.",
	statusLoading: "Loading…",
	statusUnavailable: "Settings service unavailable; the IP pool configuration cannot be read or written.",
	enabled: "Enable IP pool",
	enabledHint: "Off = every request goes direct, exactly as if the pool were not installed.",
	localFallback: "Local egress fallback",
	localFallbackHint: "On: fall back to a direct connection when no pool IP is usable (this exposes the local IP). Off (default): such a request fails instead, so the local IP never reaches the upstream; pinning This machine in the stats modal still works.",
	localIpFamily: "Local egress IP family",
	localIpFamilyHint: "Which IP family the local egress uses (a This machine pin, or the local fallback). The default, Auto, prefers IPv6 when this machine has a usable one and falls back to IPv4 — what the official client does; the free lane refuses this host's IPv4 and accepts its IPv6. IPv4-only / IPv6-only pin the family with no fallback.",
	localIpFamilyAuto: "Auto (IPv6 first)",
	localIpFamilyIpv4: "IPv4 only",
	localIpFamilyIpv6: "IPv6 only",
	poolAvailable: "{available}/{total} usable (capacity {poolSize})",
	poolSources: "Sources: manual {manual} · subscription {subscription}",
	pinnedBadge: "pinned",
	pinnedBadgeLocal: "pinned to this machine (direct)",
	pinnedSkipDead: "pinned exit {id} is dead — requests are using other exits",
	pinnedSkipCooling: "pinned exit {id} is cooling down — requests are using other exits",
	deferredNotice: "Routing deferred: {reason}",
	sectionManual: "Manual proxies",
	manualHint: "One [scheme://]host:port per line. The scheme is optional (default http): http, https, socks4, socks5 or socks5h; put IPv6 addresses in brackets, e.g. socks5://[::1]:1080; credentials are not supported. For your own nodes.",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "Subscriptions",
	subscriptionHint: "Airport/self-hosted Clash·V2ray subscription URLs, one per line; plaintext nodes dial directly, encrypted ones convert via sing-box.",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "Refresh interval (ms)",
	subscriptionRefreshMsHint: "Default 1,800,000 (30 min). Subscriptions are pulled gently, never fanned out.",
	subscriptionRefreshNow: "Refresh now",
	subscriptionStatus: "{label}: {pending} pending conversion · {admitted} converted into the pool",
	subscriptionUserAgent: "Fetch UA",
	subscriptionUserAgentHint: "User-Agent sent when pulling subscriptions. Airports commonly allow-list it (an unlisted one returns an error page or a 502), and some pick the returned format from it: a Clash-shaped UA yields YAML, a v2ray-shaped one yields base64 links. Empty = the built-in default.",
	singboxPath: "sing-box path",
	singboxPathHint: "Conversion core for encrypted nodes: PATH name or absolute path. Without it they stay \"pending conversion\".",
	pinnedAddress: "Primary exit address",
	pinnedAddressHint: "e.g. a Clash mixed port http://127.0.0.1:7897, or a leased line. Pins on save; `local` pins this machine (direct, no exit).",
	pinnedStrict: "Absolute pinning",
	pinnedStrictOn: "Absolute: never rotate, never direct",
	pinnedStrictOff: "Primary + fallback: rotate on 429/drop, return when recovered",
	pinnedUnset: "Unpin",
	probeModels: "Probe models",
	probeModelsHint: "Pick probe models from the list; none selected = default big-pickle. Multiple models stay serial per exit.",
	probeModelPick: "Pick a model…",
	probeModelUnverified: "unverified",
	probeModelsDefault: "Using the default probe model: big-pickle (first of the S3 verified list).",
	probeContents: "Probe contents",
	probeContentsHint: "The sentence the smoke request sends upstream: one entry is drawn per exit probe (shared by that exit's models); empty = default hello.",
	probeContentsPlaceholder: "e.g. hello",
	poolSize: "Pool size",
	poolSizeHint: "Exits kept online at once (1-100, default 10): the onboarding speed-tests candidates, keeps the fastest N and shrinks the sing-box listeners to them; the rest stay as reserve.",
	probeConcurrency: "Concurrency cap",
	probeConcurrencyHint: "Cross-exit probe cap (1-8, default 3); one exit is always serial.",
	probeAll: "Probe all",
	probeRunning: "Probing {done}/{total}…",
	exitAddress: "Address",
	exitSource: "Source",
	exitLatency: "Latency",
	exitQuality: "Quality",
	exitIp: "Exit IP",
	exitState: "State",
	exitPassive: "Live traffic",
	exitPassiveLabel: "ok {ok} · 429 limited {limited} · 401/403 refused {refused} · failed {failed}",
	stateOk: "ok",
	stateCooling: "cooling",
	stateAbusive: "IP flagged abusive",
	stateDead: "dead",
	stateUnknown: "unprobed",
	stateDemoted: "demoted",
	exitProbe: "Probe",
	exitPin: "Pin",
	exitPinnedMark: "primary",
	sectionBans: "Model bans",
	bansEmpty: "No banned (exit × model) pairs.",
	banBanned: "banned",
	banSuspect: "suspect",
	copyCompliance: "Anonymous quota is upstream-rate-limited; multiple exits do not bypass quota, they schedule across it.",
	footerLabel: "exits",
	footerTitle: "IP pool exit stats",
	footerUsable: "{usable}/{total} usable",
	footerRequests: "{count} requests",
	footerSpeed: "{count} tok/s",
	footerDisabled: "IP pool off",
	footerLocal: "Local direct",
	statsTitle: "Data stats",
	statsDescription: "Request counts cover this host process; tokens follow the Usage scope on the settings page (default Overview = the persistent ledger, kept across restarts). The total includes cache read/write; click a header to sort, request count desc by default.",
	statsStale: "Refresh failed; showing data from {time}.",
	statsDescriptionUsage: "The persistent usage ledger: kept across restarts, retained for {days} days; Clear stats zeroes the totals, days, sessions and exits views together.",
	statsTabsLabel: "Data stats view switch",
	statsClose: "Close",
	statsSummaryRequests: "{count} requests",
	statsSummaryTokens: "{count} tokens",
	statsSummarySpeed: "output {count} tok/s",
	statsSpeedNote: "{count} tok/s",
	statsSummaryInflight: "{count} in flight",
	statsSummaryLocal: "{count} local",
	statsSummaryDirect: "{count} direct fallbacks",
	statsColIp: "Exit IP",
	statsColRegion: "Region",
	statsColState: "State",
	statsColRequests: "Requests",
	statsColInput: "Input",
	statsColOutput: "Output",
	statsColCache: "Cache",
	statsColLatency: "Latency",
	statsColLastUsed: "Last used",
	statsColActions: "Actions",
	statsStateUsable: "usable",
	statsStateUnverified: "unverified",
	tabExits: "Exits",
	tabUsage: "Traffic",
	usageScopeLabel: "Usage scope",
	usageScopeTotal: "Overview (all time)",
	usageScopeRun: "This run",
	usageScopeHint: "Overview = the persisted ledger, kept {days} days and surviving restarts; This run = the current process. The footer entry's token figure always shows today's spend; the exit list's usage numbers follow this switch.",
	usageSummarySessions: "{count} sessions",
	usageSummaryDays: "{count} active days",
	usageRequestsShort: "{count} req",
	usageDailyTitle: "Per day",
	usageDailyEmpty: "Nothing recorded per day yet.",
	usageTopSessions: "Top sessions",
	usageBreakdownTitle: "Session and project breakdown",
	usageSessionsEmpty: "Nothing recorded per session yet.",
	usageColSession: "Session",
	usageColProject: "Project",
	usageColTokens: "Tokens",
	usageProjectsTitle: "Projects",
	usageProjectMeta: "{sessions} sessions · {tokens} tok · {requests} req",
	usageUnlabeled: "(no first turn captured)",
	usageFootnote: "Persisted: {sessions} sessions / {days} days, kept {retention} days; the all-time total lasts until you clear it.",
	usageNoStore: "No persistent ledger on this host (older host build, or the data directory is not writable).",
	usageClear: "Clear stats",
	usageClearHint: "Clear the ledger: totals, days, sessions and exits all go to zero, and the empty document is written to disk (a restart will not bring it back).",
	usageClearConfirm: "Clear every statistic? Both the all-time total and this run go to zero.",
	usageClearYes: "Clear",
	usageClearCancel: "Cancel",
	usageCleared: "Statistics cleared",
	statsLocalIp: "This machine",
	statsLocalState: "direct",
	statsPin: "Pin",
	statsUnpin: "Unpin",
	statsRotate: "Rotate",
	statsPinHint: "Pin: subsequent traffic always uses this exit",
	statsUnpinHint: "Unpin: back to automatic rotation",
	statsPinLocalHint: "Pin to this machine: everything goes direct, no exit",
	statsRotateHint: "Rotate: bring in a fresh candidate; with none left, move this row to the end of the list",
	statsActionPinned: "Pinned to this exit",
	statsActionPinnedLocal: "Pinned to this machine (direct)",
	statsActionUnpinned: "Unpinned",
	statsActionReplaced: "Rotated; a reserve took its place",
	statsActionDemoted: "Rotated: no reserve left, moved to the end of the list",
	statsActionBusy: "A rotation is already running; try again in a moment",
	statsActionVolatile: "Applied live but not persisted (lost on restart)",
	statsActionFailed: "Action failed",
	statsRefreshSubscriptionsHint: "Refresh now: re-pull the subscriptions and convert them into the pool — same action as Refresh now on the settings card.",
	statsSubscriptionRefreshed: "Subscriptions refreshed",
	statsInflight: "{count} in flight",
	statsNever: "—",
	statsEmpty: "No exit data yet: the pool is off or has admitted no exits.",
	statsPoolOff: "IP pool is off: no traffic goes through an exit, so only local (direct) egress is counted below.",
	statsPoolDeferred: "The pool is on, but the routing layer yielded: {reason}. Requests egress directly for now; only local traffic is counted below.",
	statsPoolNotReady: "The pool switch is on, but the runtime never assembled (ip-pool initialization failed; see pool.wiringError in ~/.dsh/oc2dsh/adapter-status.json).",
	statsError: "Stats fetch failed",
	save: "Save",
	saving: "Saving…",
	saved: "Saved, applied live",
	saveError: "Save failed",
	readOnly: "This configuration is read-only; changes cannot be saved.",
	invalidRange: "A value is out of range.",
	invalidProxy: "Expected [scheme://]host:port (scheme optional: http, https, socks4, socks5, socks5h; IPv6 in brackets; no credentials).",
	invalidUrl: "Enter a valid http(s) URL.",
	invalidModel: "Model id must not be empty.",
	refreshError: "Status fetch failed",
	poolConflict: "\"{field}\" changed elsewhere (the stats modal or another tab). Discard this draft to load the latest value, then edit again.",
	groupSources: "Exit sources",
	groupScheduling: "Scheduling",
	groupProbe: "Probing",
	groupUsage: "Usage",
	groupHeaders: "Zen request headers",
	groupModels: "Model context",
	groupExits: "Exits",
	summaryUnset: "not configured",
	summaryProxies: "{count} proxies",
	summarySubscriptions: "{count} subscriptions",
	summaryAuto: "auto rotation",
	summaryPinned: "pinned {target}",
	summaryModelsDefault: "default model",
	summaryModelsCount: "{count} models",
	summaryContentsCount: "{count} probe texts",
	summaryConcurrency: "concurrency {count}",
	summaryCapacity: "capacity {count}",
	summaryUsage: "{requests} req · {tokens} tok",
	summaryUsageNone: "no records yet",
	summaryHeadersDefault: "built-in default",
	summaryHeadersCustom: "{count} custom",
	summaryContextDefault: "models.dev default",
	summaryContextCustom: "{count} models overridden",
	pinnedModeFallback: "Primary + fallback",
	pinnedModeAbsolute: "Absolute",
	listAdd: "Add",
	listExists: "Already added",
	listRemove: "Remove"
};

//#endregion
//#region src/client/index.ts
/** Dictionary namespace owned by this plugin. */
const NS = "settings.ip-pool";
/**
* The Host settings entry this page edits: the Loader entry id, which is the
* plugin name. The editable field inside it is `ipPool`.
*/
const SETTINGS_NAMESPACE = "oc2dsh";
/** Where this page sorts among the Plugins page's official entries. */
const ORDER = 20;
/**
* Required services (cordis fiber inject).
*
* Only stable services gate the main fiber. configForms is requested in a
* separate fiber and owns the settings contribution's served lifetime.
*/
const inject = ["slots", "locale"];
/**
* Mount the IP 池 page whenever the Host serves this entry's settings.
* @param ctx - the browser plugin context.
*/
function apply(ctx) {
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "oc2dsh: copy dictionaries");
	const slots = ctx.slots;
	ctx.inject(["configForms"], (formCtx) => {
		formCtx.effect(() => formCtx.configForms.whileServed([SETTINGS_NAMESPACE], () => {
			const bundle = slots.inject("plugins.bundle.config", () => {
				const card = bundleConfigCard(formCtx.configForms.get(SETTINGS_NAMESPACE));
				const disposers = ["dsh-opencode2free-provider", "oc2dsh"].map((pkg) => slots.register({
					name: "plugins.bundle.config",
					key: pkg,
					locale: NS
				}, card));
				return () => {
					for (const dispose of disposers) dispose();
				};
			});
			const legacy = slots.inject("plugins.item", () => {
				if (slots.spec("plugins.bundle.config") !== void 0) return () => {};
				return slots.register({
					name: "plugins.item",
					id: SETTINGS_NAMESPACE,
					order: ORDER,
					label: () => t("title"),
					locale: NS
				}, IpPoolCard);
			});
			const footer = slots.inject("sidebar.footer.action", () => slots.register({
				name: "sidebar.footer.action",
				id: "ip-pool-exits",
				order: 10,
				locale: NS
			}, ExitStatsEntry));
			return () => {
				bundle();
				legacy();
				footer();
			};
		}), "oc2dsh: settings page");
	});
}

//#endregion
exports.NS = NS;
exports.SETTINGS_NAMESPACE = SETTINGS_NAMESPACE;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map