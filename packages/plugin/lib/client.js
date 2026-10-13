window.__ModuleLoader__.load({ id: "@opencode2dsh/dsh-plugin", factory: (require) => {
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

//#region \0dsh-css:/Users/ankh/workspace/private/opencode2dsh/packages/plugin/src/client/ip-pool.module.css.mjs
const css = ".QmduLW_body{flex-direction:column;gap:14px;display:flex}.QmduLW_status{color:var(--dsw-alias-label-tertiary,#6b7280);margin:4px 0;font-size:13px;line-height:1.5}.QmduLW_field{flex-direction:column;gap:4px;display:flex}.QmduLW_fieldRow{gap:10px;display:flex}.QmduLW_fieldRow>.QmduLW_field{flex:1 1 0;min-width:0}.QmduLW_fieldLabel{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:500}.QmduLW_fieldHint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:1.45}.QmduLW_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);width:100%;color:var(--dsw-alias-label-primary,#1f2329);color-scheme:light;border-radius:6px;padding:6px 8px;font-size:13px}.QmduLW_input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-1px}body[data-ds-dark-theme] .QmduLW_input,body[data-ds-dark-theme] .QmduLW_select{color-scheme:dark}.QmduLW_textarea{resize:vertical;min-height:56px;font-family:inherit;}.QmduLW_rowList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.QmduLW_row{align-items:center;gap:6px;display:flex}.QmduLW_rowLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);flex:1 1 0;font-size:13px;overflow:hidden}.QmduLW_rowInput{flex:1 1 0;}.QmduLW_rowRemove{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:6px;flex:none;padding:4px 8px;font-size:12px}.QmduLW_rowRemove:hover{border-color:var(--dsw-alias-state-error-primary,#d1242f);color:var(--dsw-alias-state-error-primary,#d1242f)}.QmduLW_rowAdd{border:1px dashed var(--dsw-alias-border-l3,#a6adb4);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;background:0 0;border-radius:6px;align-self:flex-start;padding:4px 10px;font-size:12px}.QmduLW_rowAdd:hover{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.QmduLW_ghostButton{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:6px;padding:6px 12px;font-size:13px}.QmduLW_ghostButton:hover{border-color:var(--dsw-alias-border-l3,#a6adb4)}.QmduLW_saveStatus{font-size:12px;line-height:1.4}.QmduLW_saveStatusOk{color:var(--dsw-alias-state-success-primary,#1a7f37)}.QmduLW_saveStatusError{color:var(--dsw-alias-state-error-primary,#d1242f)}.QmduLW_overviewBar{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);border-radius:8px;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 10px;font-size:12px;display:flex}.QmduLW_badge{border:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;border-radius:999px;align-items:center;gap:4px;padding:2px 8px;font-size:11px;line-height:1.5;display:inline-flex}.QmduLW_badgeHealthy{border-color:var(--dsw-alias-state-success-primary,#1a7f37);color:var(--dsw-alias-state-success-primary,#1a7f37)}.QmduLW_badgeWarning{border-color:var(--dsw-alias-state-warning-primary,#9a6700);color:var(--dsw-alias-state-warning-primary,#9a6700)}.QmduLW_badgeCritical,.QmduLW_badgeEmergency{border-color:var(--dsw-alias-state-error-primary,#d1242f);color:var(--dsw-alias-state-error-primary,#d1242f)}.QmduLW_badgePinned{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.QmduLW_table{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;display:block;overflow-x:auto}.QmduLW_tableGrid{border-collapse:collapse;width:100%;font-size:12px}.QmduLW_tableGrid th,.QmduLW_tableGrid td{border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);text-align:left;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;padding:6px 8px}.QmduLW_tableGrid th{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-2,#f6f8fa);font-weight:600}.QmduLW_tableGrid tr:last-child td{border-bottom:none}.QmduLW_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.QmduLW_stateOk{color:var(--dsw-alias-state-success-primary,#1a7f37)}.QmduLW_stateCooling{color:var(--dsw-alias-state-warning-primary,#9a6700)}.QmduLW_stateDead{color:var(--dsw-alias-state-error-primary,#d1242f)}.QmduLW_stateUnknown{color:var(--dsw-alias-label-tertiary,#6b7280)}.QmduLW_section{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fe80);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}.QmduLW_sectionTitle{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:600}.QmduLW_radio{color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;align-items:center;gap:6px;font-size:13px;display:flex}.QmduLW_compliance{color:var(--dsw-alias-label-tertiary,#6b7280);border-top:1px dashed var(--dsw-alias-border-l2,#d0d7de);padding-top:10px;font-size:11px;line-height:1.5}.QmduLW_collapseToggle{color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;background:0 0;border:none;align-self:flex-start;padding:2px 8px;font-size:12px}.QmduLW_footerEntry{width:100%;color:var(--dsw-alias-label-primary,#1f2329);text-align:left;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:12px;display:flex}.QmduLW_footerEntry:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-color:var(--dsw-alias-border-l2,#d0d7de)}.QmduLW_footerIcon{color:var(--dsw-alias-state-business-primary,#4f8cff);font-size:14px;line-height:1}.QmduLW_footerText{flex-direction:column;min-width:0;display:flex}.QmduLW_footerMain{white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600;line-height:1.25;overflow:hidden}.QmduLW_footerUnit{color:var(--dsw-alias-label-secondary,#4b5563);font-weight:400}.QmduLW_footerSub{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}.QmduLW_statsSummary{flex-wrap:wrap;gap:6px;margin-bottom:10px;display:flex}.QmduLW_statsChip{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;border-radius:999px;padding:2px 8px;font-size:11px}.QmduLW_statsModal.QmduLW_statsModal{width:min(1040px,100%);max-height:100%}.QmduLW_statsContent{flex:auto;min-height:0;overflow-y:auto}.QmduLW_statsWrap{overflow-x:hidden}.QmduLW_statsTable{table-layout:fixed;border-collapse:collapse;width:100%;font-size:12px}.QmduLW_statsTable th:first-child{width:22%}.QmduLW_statsTable th:nth-child(2){width:14%}.QmduLW_statsTable th:nth-child(3){width:11%}.QmduLW_statsTable th:nth-child(4),.QmduLW_statsTable th:nth-child(5){width:10%}.QmduLW_statsTable th:nth-child(6){width:11%}.QmduLW_statsTable th:nth-child(7){width:22%}.QmduLW_statsTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#6b7280);border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);white-space:normal;padding:6px 8px;font-weight:600}.QmduLW_statsTable td{border-bottom:1px solid var(--dsw-alias-border-l3,#eaeef2);color:var(--dsw-alias-label-primary,#1f2329);white-space:normal;overflow-wrap:anywhere;padding:6px 8px}.QmduLW_statsRowMuted td{color:var(--dsw-alias-label-tertiary,#6b7280)}.QmduLW_statsRowLocal td{border-top:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#4b5563);border-bottom:none;font-weight:500}.QmduLW_statsDotLocal{background:var(--dsw-alias-label-tertiary,#6b7280)}.QmduLW_statsDot{vertical-align:middle;border-radius:50%;width:7px;height:7px;margin-right:5px;display:inline-block}.QmduLW_statsDotOk{background:var(--dsw-alias-state-success-primary,#1a7f37)}.QmduLW_statsDotWarn{background:var(--dsw-alias-state-warning-primary,#9a6700)}.QmduLW_statsDotBad{background:var(--dsw-alias-state-error-primary,#d1242f)}.QmduLW_statsInflight{background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff;border-radius:999px;margin-right:6px;padding:0 6px;font-size:10px;line-height:1.6;display:inline-block}";
const tagId = "@opencode2dsh/dsh-plugin/ip-pool.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@opencode2dsh/dsh-plugin";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var ip_pool_module_css_default = {
	"footerMain": "QmduLW_footerMain",
	"compliance": "QmduLW_compliance",
	"badgePinned": "QmduLW_badgePinned",
	"fieldLabel": "QmduLW_fieldLabel",
	"tableGrid": "QmduLW_tableGrid",
	"mono": "QmduLW_mono",
	"fieldHint": "QmduLW_fieldHint",
	"stateOk": "QmduLW_stateOk",
	"sectionTitle": "QmduLW_sectionTitle",
	"radio": "QmduLW_radio",
	"statsDotBad": "QmduLW_statsDotBad",
	"footerIcon": "QmduLW_footerIcon",
	"ghostButton": "QmduLW_ghostButton",
	"rowInput": "QmduLW_rowInput",
	"body": "QmduLW_body",
	"collapseToggle": "QmduLW_collapseToggle",
	"statsChip": "QmduLW_statsChip",
	"stateDead": "QmduLW_stateDead",
	"rowLabel": "QmduLW_rowLabel",
	"statsRowLocal": "QmduLW_statsRowLocal",
	"stateCooling": "QmduLW_stateCooling",
	"statsDotWarn": "QmduLW_statsDotWarn",
	"footerUnit": "QmduLW_footerUnit",
	"textarea": "QmduLW_textarea",
	"row": "QmduLW_row",
	"statsInflight": "QmduLW_statsInflight",
	"statsWrap": "QmduLW_statsWrap",
	"badgeEmergency": "QmduLW_badgeEmergency",
	"saveStatusOk": "QmduLW_saveStatusOk",
	"badgeHealthy": "QmduLW_badgeHealthy",
	"field": "QmduLW_field",
	"statsContent": "QmduLW_statsContent",
	"footerEntry": "QmduLW_footerEntry",
	"badgeWarning": "QmduLW_badgeWarning",
	"statsDotOk": "QmduLW_statsDotOk",
	"section": "QmduLW_section",
	"overviewBar": "QmduLW_overviewBar",
	"select": "QmduLW_select",
	"saveStatusError": "QmduLW_saveStatusError",
	"statsDot": "QmduLW_statsDot",
	"table": "QmduLW_table",
	"footerText": "QmduLW_footerText",
	"status": "QmduLW_status",
	"rowAdd": "QmduLW_rowAdd",
	"fieldRow": "QmduLW_fieldRow",
	"footerSub": "QmduLW_footerSub",
	"statsRowMuted": "QmduLW_statsRowMuted",
	"rowList": "QmduLW_rowList",
	"input": "QmduLW_input",
	"badge": "QmduLW_badge",
	"statsTable": "QmduLW_statsTable",
	"stateUnknown": "QmduLW_stateUnknown",
	"statsSummary": "QmduLW_statsSummary",
	"statsModal": "QmduLW_statsModal",
	"statsDotLocal": "QmduLW_statsDotLocal",
	"badgeCritical": "QmduLW_badgeCritical",
	"rowRemove": "QmduLW_rowRemove",
	"saveStatus": "QmduLW_saveStatus"
};

//#endregion
//#region src/client/settings-writes.ts
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
//#region src/client/IpPoolCard.tsx
/** Copy of the form chrome (the shared SettingsForm labels). */
const formLabels = (t) => ({
	unavailable: t("statusUnavailable"),
	readOnly: t("readOnly"),
	saveFailed: t("saveError"),
	save: t("save"),
	saving: t("saving")
});
/** The bridge prefix (same-origin, loopback-only on the host). */
const BRIDGE_PREFIX = "/api/opencode2dsh/ip-pool";
/**
* The field inside the served entry that holds the editable section: the
* `ipPool` volatile node in the plugin's Config schema. Every write path is
* `['ipPool', <field>]`, because the Host's volatile form keeps the node's
* field name in front of the fields it makes editable.
*/
const IP_POOL_FIELD = "ipPool";
const DEFAULTS = {
	enabled: false,
	probeModels: [],
	maxConcurrentProbes: 3,
	free: {
		enabled: true,
		targetSize: 20,
		blockedCountries: ["CN"]
	},
	manual: [],
	subscription: {
		urls: [],
		refreshMs: 30 * 6e4,
		userAgent: "clash-verge/v2.0"
	},
	singbox: { path: "sing-box" },
	pinnedExitId: "",
	pinnedStrict: false,
	proxyHosts: []
};
/** Subscription URLs never render in full — the settings doc is the only
*  place they exist in plaintext (docs §5.1 redaction boundary). */
function redactUrl(url) {
	if (url.length <= 24) return url;
	return url.slice(0, 12) + "…" + url.slice(-6);
}
function emptyForm() {
	return {
		enabled: DEFAULTS.enabled,
		freeEnabled: DEFAULTS.free.enabled,
		targetSize: String(DEFAULTS.free.targetSize),
		blockedCountries: DEFAULTS.free.blockedCountries.join(","),
		manual: [],
		subscriptionUrls: [],
		refreshMs: String(DEFAULTS.subscription.refreshMs),
		userAgent: DEFAULTS.subscription.userAgent,
		singboxPath: DEFAULTS.singbox.path,
		pinnedExitId: "",
		pinnedStrict: DEFAULTS.pinnedStrict,
		probeModels: [],
		maxConcurrentProbes: String(DEFAULTS.maxConcurrentProbes)
	};
}
function formFromValue(value) {
	return {
		enabled: value.enabled,
		freeEnabled: value.free.enabled,
		targetSize: String(value.free.targetSize),
		blockedCountries: value.free.blockedCountries.join(","),
		manual: [...value.manual],
		subscriptionUrls: [...value.subscription.urls],
		refreshMs: String(value.subscription.refreshMs),
		userAgent: value.subscription.userAgent,
		singboxPath: value.singbox.path,
		pinnedExitId: value.pinnedExitId,
		pinnedStrict: value.pinnedStrict,
		probeModels: [...value.probeModels],
		maxConcurrentProbes: String(value.maxConcurrentProbes)
	};
}
/** Field writes landing the form on the resolved value, in write order. */
/**
* The ip-pool section of the served value, with defaults filled. A missing
* section (an empty document, or a namespace the Host serves empty) reads as
* the documented defaults so the form still renders.
*/
function servedSection(state) {
	const served = (state?.value)?.ipPool;
	const nestedUrls = served?.subscription?.urls ?? [];
	const legacyUrls = served?.subscriptions ?? [];
	return {
		...DEFAULTS,
		...served,
		free: {
			...DEFAULTS.free,
			...served?.free
		},
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
function diffWrites(form, value, base) {
	const writes = [];
	const push = (field, next, current, baseValue) => {
		const edit = fieldWrite(field, next, current, baseValue);
		if (edit !== void 0) writes.push(edit);
	};
	push("enabled", form.enabled, value.enabled, base.enabled);
	push("free", {
		enabled: form.freeEnabled,
		targetSize: Number(form.targetSize),
		blockedCountries: splitCsv(form.blockedCountries)
	}, value.free, base.free);
	push("manual", form.manual, value.manual, base.manual);
	push("subscription", {
		urls: form.subscriptionUrls,
		refreshMs: Number(form.refreshMs),
		userAgent: normalizedUserAgent(form.userAgent)
	}, value.subscription, base.subscription);
	push("singbox", { path: form.singboxPath }, value.singbox, base.singbox);
	push("pinnedExitId", form.pinnedExitId, value.pinnedExitId, base.pinnedExitId);
	push("pinnedStrict", form.pinnedStrict, value.pinnedStrict, base.pinnedStrict);
	push("probeModels", form.probeModels, value.probeModels, base.probeModels);
	push("maxConcurrentProbes", Number(form.maxConcurrentProbes), value.maxConcurrentProbes, base.maxConcurrentProbes);
	return writes;
}
function splitCsv(line) {
	return line.split(",").map((part) => part.trim().toUpperCase()).filter((part) => part.length > 0);
}
/** Clearing the UA field restores the default instead of writing an empty
*  header — the Host schema and the runtime both treat empty as "default",
*  and this keeps a cleared field from looking like a pending change. */
function normalizedUserAgent(value) {
	const trimmed = value.trim();
	return trimmed === "" ? DEFAULTS.subscription.userAgent : trimmed;
}
/** One-line live refill progress: stage + counters (docs §5.3). */
function refillProgressLine(progress, t) {
	const parts = [{
		fetch: t("refillStageFetch"),
		coarse: t("refillStageCoarse"),
		admit: t("refillStageAdmit"),
		idle: t("refillStageIdle")
	}[progress.stage]];
	if (progress.stage === "fetch") {
		const sources = t("refillCountSources").replace("{done}", String(progress.sourcesDone)).replace("{total}", String(progress.sourcesTotal));
		const rows = t("refillCountFetched").replace("{n}", String(progress.fetched));
		parts.push(sources + " · " + rows);
	}
	if (progress.stage === "coarse") parts.push(t("refillCountCoarse").replace("{done}", String(progress.coarseDone)).replace("{total}", String(progress.candidates)).replace("{passed}", String(progress.coarsePassed)));
	if (progress.stage === "admit") parts.push(t("refillCountAdmit").replace("{done}", String(progress.admissions)).replace("{admitted}", String(progress.admitted)));
	return parts.join(" · ");
}
/** One labeled input. */
function TextField(props) {
	const { label, hint, value, onChange, placeholder, testId, type = "text", min, max, step } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: ip_pool_module_css_default.field,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				className: ip_pool_module_css_default.input,
				type,
				value,
				placeholder,
				min,
				max,
				step,
				"data-testid": testId,
				onChange: (event) => onChange(event.target.value)
			}),
			hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: hint
			})
		]
	});
}
/** One editable string-list (manual proxies / subscription URLs / probe models). */
function StringList(props) {
	const { label, hint, values, placeholder, testId, redacted, onChange } = props;
	const [draft, setDraft] = (0, react.useState)("");
	const add = () => {
		const entry = draft.trim();
		if (entry === "" || values.includes(entry)) return;
		onChange([...values, entry]);
		setDraft("");
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.field,
		"data-testid": testId,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: hint
			}),
			values.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: ip_pool_module_css_default.rowList,
				children: values.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: ip_pool_module_css_default.row,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.rowLabel,
						title: redacted ? entry : void 0,
						children: redacted ? redactUrl(entry) : entry
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: ip_pool_module_css_default.rowRemove,
						onClick: () => onChange(values.filter((v) => v !== entry)),
						children: "✕"
					})]
				}, entry))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ip_pool_module_css_default.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: ip_pool_module_css_default.rowInput,
					value: draft,
					placeholder,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: ip_pool_module_css_default.rowAdd,
					onClick: add,
					children: "+"
				})]
			})
		]
	});
}
/**
* Probe-model multi-select over the bridge /models rows: selected models as
* removable chips above a dropdown of S3-verified + live-catalog options
* (docs §5.2 探活模型). Empty selection = the S3-first default (big-pickle).
*/
function ModelPicker(props) {
	const { value, hint, models, loading, t, onChange } = props;
	const toggle = (id) => {
		onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);
	};
	const options = models.filter((row) => !value.includes(row.id));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.field,
		"data-testid": "field-probeModels",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: t("probeModels")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: hint
			}),
			value.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: ip_pool_module_css_default.rowList,
				children: value.map((id) => {
					const row = models.find((m) => m.id === id);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: ip_pool_module_css_default.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: ip_pool_module_css_default.rowLabel,
							children: [id, row?.verified === false ? ` · ${t("probeModelUnverified")}` : ""]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ip_pool_module_css_default.rowRemove,
							"aria-label": "remove",
							onClick: () => toggle(id),
							children: "✕"
						})]
					}, id);
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ip_pool_module_css_default.row,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					className: ip_pool_module_css_default.select,
					"data-testid": "probe-model-select",
					value: "",
					disabled: options.length === 0,
					onChange: (event) => {
						const id = event.target.value;
						if (id !== "") toggle(id);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: loading ? t("statusLoading") : options.length === 0 ? "—" : t("probeModelPick")
					}), options.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
						value: row.id,
						children: [row.id, row.verified === false ? ` · ${t("probeModelUnverified")}` : ""]
					}, row.id))]
				})
			}),
			value.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: t("probeModelsDefault")
			})
		]
	});
}
/** Pool overview strip: four-state badge + counts + pinned badge. */
function OverviewBar(props) {
	const { status, t } = props;
	if (status === null) return null;
	const stateLabel = {
		healthy: t("poolStateHealthy"),
		warning: t("poolStateWarning"),
		critical: t("poolStateCritical"),
		emergency: t("poolStateEmergency")
	};
	const stateClass = {
		healthy: ip_pool_module_css_default.badgeHealthy,
		warning: ip_pool_module_css_default.badgeWarning,
		critical: ip_pool_module_css_default.badgeCritical,
		emergency: ip_pool_module_css_default.badgeEmergency
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.overviewBar,
		"data-testid": "ip-pool-overview",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: `${ip_pool_module_css_default.badge} ${stateClass[status.state]}`,
				title: status.stateBasis === "pool" ? t("stateBasisPool") : t("stateBasisFree"),
				children: stateLabel[status.state]
			}),
			status.deferredReason !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: `${ip_pool_module_css_default.badge} ${ip_pool_module_css_default.badgeCritical}`,
				children: t("deferredNotice").replace("{reason}", status.deferredReason)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolAvailable").replace("{available}", String(status.availableTotal)).replace("{total}", String(status.total)).replace("{freeAvailable}", String(status.availableFree)).replace("{capacity}", String(status.targetSize)) }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolSources").replace("{free}", String(status.bySource.free)).replace("{manual}", String(status.bySource.manual)).replace("{subscription}", String(status.bySource.subscription)) }),
			status.pinned !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: `${ip_pool_module_css_default.badge} ${ip_pool_module_css_default.badgePinned}`,
				children: [t("pinnedBadge"), status.pinned.strict ? " (" + t("pinnedStrict") + ")" : ""]
			})
		]
	});
}
/** The exit table + ban list. */
function ExitTable(props) {
	const { status, t, onProbe, onPin, busy } = props;
	const [bansOpen, setBansOpen] = (0, react.useState)(false);
	if (status === null) return null;
	const stateCell = (exit) => {
		if (exit.state === "dead") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.stateDead,
			children: t("stateDead")
		});
		if (exit.cooling) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.stateCooling,
			children: t("stateCooling")
		});
		if (exit.state === "ok") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.stateOk,
			children: t("stateOk")
		});
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.stateUnknown,
			children: t("stateUnknown")
		});
	};
	const allBans = status.exits.flatMap((exit) => exit.bannedModels.map((ban) => ({
		exitId: exit.id,
		...ban
	})));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: ip_pool_module_css_default.table,
		"data-testid": "ip-pool-exits",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			className: ip_pool_module_css_default.tableGrid,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitAddress") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitSource") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitLocation") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitLatency") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitQuality") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitIp") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitState") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("exitPassive") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {})
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [status.exits.map((exit) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
					className: ip_pool_module_css_default.mono,
					children: [exit.id, exit.pinned ? ` · ${t("exitPinnedMark")}` : ""]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.source }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.exitLocation || "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? exit.quality : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: ip_pool_module_css_default.mono,
					children: exit.exitIP || "—"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stateCell(exit) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: ip_pool_module_css_default.mono,
					children: exit.passive.ok > 0 || exit.passive.limited > 0 || exit.passive.refused > 0 || exit.passive.dead > 0 || exit.passive.transport > 0 ? `✓${exit.passive.ok} 429:${exit.passive.limited} 401/403:${exit.passive.refused} ✗:${exit.passive.dead + exit.passive.transport}` : "—"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: ip_pool_module_css_default.rowRemove,
					disabled: busy,
					onClick: () => onProbe(exit.id),
					children: t("exitProbe")
				}), !exit.pinned && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: ip_pool_module_css_default.rowRemove,
					disabled: busy,
					onClick: () => onPin(exit.id),
					children: t("exitPin")
				})] })
			] }, exit.id)), status.exits.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
				colSpan: 9,
				className: ip_pool_module_css_default.status,
				children: t("statusUnavailable")
			}) })] })]
		})
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.section,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: ip_pool_module_css_default.collapseToggle,
			onClick: () => setBansOpen((open) => !open),
			children: [
				t(bansOpen ? "collapse" : "expand"),
				" · ",
				t("sectionBans"),
				" (",
				allBans.length,
				")"
			]
		}), bansOpen && (allBans.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.status,
			children: t("bansEmpty")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
			className: ip_pool_module_css_default.rowList,
			children: allBans.map((ban) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: ip_pool_module_css_default.row,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: ip_pool_module_css_default.rowLabel,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ban.state === "banned" ? ip_pool_module_css_default.stateDead : ip_pool_module_css_default.stateCooling,
							children: ban.state === "banned" ? t("banBanned") : t("banSuspect")
						}),
						" · ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.mono,
							children: ban.exitId
						}),
						" × ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.mono,
							children: ban.model
						})
					]
				})
			}, `${ban.exitId}|${ban.model}`))
		}))]
	})] });
}
/** The card body. */
function CardBody(props) {
	const { settings, t } = props;
	const snapshot = settings?.state;
	const [form, setForm] = (0, react.useState)(() => emptyForm());
	const [saving, setSaving] = (0, react.useState)(false);
	const [saved, setSaved] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)(null);
	const [statusError, setStatusError] = (0, react.useState)(null);
	const [probeModelRows, setProbeModelRows] = (0, react.useState)([]);
	const [probeModelsLoading, setProbeModelsLoading] = (0, react.useState)(false);
	const [actionBusy, setActionBusy] = (0, react.useState)(false);
	const hydratedRef = (0, react.useRef)(false);
	const formRef = (0, react.useRef)(form);
	formRef.current = form;
	const served = servedSection(snapshot);
	const servedRef = (0, react.useRef)(served);
	servedRef.current = served;
	(0, react.useEffect)(() => {
		if (snapshot?.status === "ready" && !hydratedRef.current) {
			hydratedRef.current = true;
			setForm(formFromValue(servedRef.current));
		}
	}, [snapshot?.status, snapshot?.value]);
	(0, react.useEffect)(() => {
		let cancelled = false;
		setProbeModelsLoading(true);
		fetch(`${BRIDGE_PREFIX}/models`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}"
		}).then((response) => response.json()).then((body) => {
			if (!cancelled && body.ok && body.value) setProbeModelRows(body.value.models);
		}).catch(() => {}).finally(() => {
			if (!cancelled) setProbeModelsLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const probing = status !== null && status.prober.queued + status.prober.inFlight > 0;
	const refilling = status?.refill?.progress.running === true;
	const refreshStatus = (0, react.useCallback)(async () => {
		try {
			const body = await (await fetch(`${BRIDGE_PREFIX}/status`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}"
			})).json();
			if (body.ok && body.value) {
				setStatus(body.value);
				setStatusError(null);
			} else setStatusError(t("refreshError"));
		} catch {
			setStatusError(t("refreshError"));
		}
	}, [t]);
	(0, react.useEffect)(() => {
		if (snapshot?.status !== "ready" || !hydratedRef.current || !form.enabled) return;
		refreshStatus();
		const interval = setInterval(() => void refreshStatus(), probing || refilling ? 1e3 : 3e3);
		return () => clearInterval(interval);
	}, [
		snapshot?.status,
		form.enabled,
		probing,
		refilling,
		refreshStatus,
		hydratedRef.current
	]);
	if (snapshot?.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		className: ip_pool_module_css_default.status,
		children: t("statusLoading")
	});
	const validate = () => {
		const size = Number(form.targetSize);
		if (!/^\d+$/.test(form.targetSize.trim()) || size < 1 || size > 100) return t("invalidRange");
		const conc = Number(form.maxConcurrentProbes);
		if (!/^\d+$/.test(form.maxConcurrentProbes.trim()) || conc < 1 || conc > 8) return t("invalidRange");
		const refresh = Number(form.refreshMs);
		if (!/^\d+$/.test(form.refreshMs.trim()) || refresh < 6e4) return t("invalidRange");
		for (const entry of form.manual) if (!/^https?:\/\/[^\s:]+:\d{1,5}$|^socks5:\/\/[^\s:]+:\d{1,5}$|^socks5h?:\/\/\[[^\]]+\]:\d{1,5}$/.test(entry)) return t("invalidProxy");
		for (const url of form.subscriptionUrls) if (!/^https?:\/\/.+/.test(url)) return t("invalidUrl");
		for (const country of splitCsv(form.blockedCountries)) if (!/^[A-Z]{2}$/.test(country)) return t("invalidCountry");
		for (const model of form.probeModels) if (model.trim() === "") return t("invalidModel");
		return null;
	};
	const writes = diffWrites(formRef.current, served, servedBase(snapshot));
	const validation = validate();
	const dirty = writes.length > 0 || validation !== null;
	const available = snapshot?.status === "ready" && settings !== void 0;
	const writable = available && snapshot.writable;
	const handleSave = async () => {
		if (!writable || validation !== null || settings === void 0 || snapshot === void 0) {
			setSaved(false);
			setError(validation ?? t("saveError"));
			return;
		}
		if (writes.length === 0) {
			setSaved(true);
			setError(null);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const ok = await settings.mutate(poolWriteOps(writes), snapshot.revision);
			setSaved(ok);
			setError(ok ? null : t("saveError"));
		} catch (err) {
			setSaved(false);
			setError(err instanceof Error ? err.message : t("saveError"));
		} finally {
			setSaving(false);
		}
	};
	/** The shared SettingsForm discard: drop the draft, keep the served values. */
	const handleDiscard = () => {
		setForm(formFromValue(servedRef.current));
		setSaved(false);
		setError(null);
	};
	const shell = {
		available,
		writable,
		dirty,
		invalid: validation !== null,
		saving,
		failed: error !== null
	};
	/** One bridge action (/probe). */
	const bridgeAction = async (body) => {
		setActionBusy(true);
		try {
			await fetch(`${BRIDGE_PREFIX}/probe`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			await refreshStatus();
		} catch {
			setStatusError(t("refreshError"));
		} finally {
			setActionBusy(false);
		}
	};
	/** Pin an exit from the table: writes pinnedExitId and saves immediately. */
	const pinExit = async (exitId) => {
		if (!writable || settings === void 0 || snapshot === void 0) return;
		setActionBusy(true);
		try {
			if (!await settings.mutate([{
				op: "set",
				path: [IP_POOL_FIELD, "pinnedExitId"],
				value: exitId
			}], snapshot.revision)) throw new Error(t("saveError"));
			setForm((current) => ({
				...current,
				pinnedExitId: exitId
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : t("saveError"));
		} finally {
			setActionBusy(false);
		}
	};
	const probeDone = status !== null ? status.prober.completed : 0;
	const probeTotal = status !== null ? status.prober.enqueued : 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
		labels: formLabels(t),
		state: shell,
		onSave: () => {
			handleSave();
		},
		onDiscard: handleDiscard,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: ip_pool_module_css_default.body,
			"data-testid": "ip-pool-form",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverviewBar, {
					status: form.enabled ? status : null,
					t
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: ip_pool_module_css_default.radio,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: form.enabled,
						"data-testid": "field-enabled",
						onChange: (event) => {
							setSaved(false);
							setForm({
								...form,
								enabled: event.target.checked
							});
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.fieldLabel,
						children: t("enabled")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: ip_pool_module_css_default.fieldHint,
						children: [" ", t("enabledHint")]
					})] })]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.section,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.sectionTitle,
							children: t("sectionFree")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: ip_pool_module_css_default.radio,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: form.freeEnabled,
								"data-testid": "field-freeEnabled",
								onChange: (event) => {
									setSaved(false);
									setForm({
										...form,
										freeEnabled: event.target.checked
									});
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.fieldLabel,
								children: t("freeEnabled")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: ip_pool_module_css_default.fieldHint,
								children: [" ", t("freeEnabledHint")]
							})] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ip_pool_module_css_default.fieldRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("freeTargetSize"),
								hint: t("freeTargetSizeHint"),
								value: form.targetSize,
								testId: "field-targetSize",
								type: "number",
								min: 1,
								max: 100,
								step: 1,
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										targetSize: value
									});
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("freeBlockedCountries"),
								hint: t("freeBlockedCountriesHint"),
								value: form.blockedCountries,
								testId: "field-blockedCountries",
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										blockedCountries: value
									});
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ip_pool_module_css_default.ghostButton,
							"data-testid": "refill-now",
							disabled: actionBusy || !form.enabled || refilling,
							onClick: () => {
								bridgeAction({ scope: "refill" });
							},
							children: refilling ? t("refillRunning") : t("refillNow")
						}),
						refilling && status?.refill?.progress !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.status,
							"data-testid": "refill-progress",
							children: refillProgressLine(status.refill.progress, t)
						}),
						!refilling && status?.refill?.progress.stage === "idle" && (status.refill.progress.admitted > 0 || status.refill.progress.admissions > 0) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.status,
							children: t("refillSummary").replace("{admitted}", String(status.refill.progress.admitted)).replace("{fetched}", String(status.refill.progress.candidates))
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.section,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.sectionTitle,
						children: t("sectionManual")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StringList, {
						label: t("sectionManual"),
						hint: t("manualHint"),
						values: form.manual,
						placeholder: t("manualPlaceholder"),
						testId: "field-manual",
						onChange: (next) => {
							setSaved(false);
							setForm({
								...form,
								manual: next
							});
						}
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.section,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.sectionTitle,
							children: t("sectionSubscription")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StringList, {
							label: t("sectionSubscription"),
							hint: t("subscriptionHint"),
							values: form.subscriptionUrls,
							placeholder: t("subscriptionPlaceholder"),
							testId: "field-subscriptions",
							redacted: true,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									subscriptionUrls: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ip_pool_module_css_default.fieldRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("subscriptionRefreshMs"),
								hint: t("subscriptionRefreshMsHint"),
								value: form.refreshMs,
								testId: "field-refreshMs",
								type: "number",
								min: 6e4,
								step: 1,
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										refreshMs: value
									});
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: ip_pool_module_css_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.fieldLabel,
									children: " "
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: ip_pool_module_css_default.ghostButton,
									"data-testid": "refresh-subscriptions",
									disabled: actionBusy || !form.enabled,
									onClick: () => {
										bridgeAction({ scope: "subscription" });
									},
									children: t("subscriptionRefreshNow")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: ip_pool_module_css_default.fieldRow,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("subscriptionUserAgent"),
								hint: t("subscriptionUserAgentHint"),
								value: form.userAgent,
								testId: "field-subscriptionUserAgent",
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										userAgent: value
									});
								}
							})
						}),
						status?.subscription !== null && status?.subscription !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: ip_pool_module_css_default.status,
							children: [
								t("sectionSubscription"),
								": ",
								status.subscription.pendingConversion,
								" 待转换 · ",
								status.subscription.convertedAdmitted,
								" 已转换入池",
								status.subscription.lastError !== "" ? ` · ${status.subscription.lastError}` : ""
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
							label: t("singboxPath"),
							hint: t("singboxPathHint"),
							value: form.singboxPath,
							testId: "field-singboxPath",
							onChange: (value) => {
								setSaved(false);
								setForm({
									...form,
									singboxPath: value
								});
							}
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.section,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.sectionTitle,
							children: t("sectionPinned")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
							label: t("pinnedAddress"),
							hint: t("pinnedAddressHint"),
							value: form.pinnedExitId,
							placeholder: t("manualPlaceholder"),
							testId: "field-pinnedExitId",
							onChange: (value) => {
								setSaved(false);
								setForm({
									...form,
									pinnedExitId: value
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.fieldLabel,
							children: t("pinnedStrict")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.fieldHint,
							children: t("pinnedStrictHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: ip_pool_module_css_default.radio,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "ip-pool-strict",
								checked: !form.pinnedStrict,
								onChange: () => {
									setSaved(false);
									setForm({
										...form,
										pinnedStrict: false
									});
								}
							}), t("pinnedStrictOff")]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: ip_pool_module_css_default.radio,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "ip-pool-strict",
								checked: form.pinnedStrict,
								"data-testid": "field-pinnedStrict",
								onChange: () => {
									setSaved(false);
									setForm({
										...form,
										pinnedStrict: true
									});
								}
							}), t("pinnedStrictOn")]
						}),
						form.pinnedExitId !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ip_pool_module_css_default.ghostButton,
							"data-testid": "unpin",
							disabled: saving,
							onClick: () => {
								setSaved(false);
								setForm({
									...form,
									pinnedExitId: ""
								});
							},
							children: t("pinnedUnset")
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.section,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.sectionTitle,
							children: t("sectionProbe")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
							value: form.probeModels,
							hint: t("probeModelsHint"),
							models: probeModelRows,
							loading: probeModelsLoading,
							t,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									probeModels: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
							label: t("probeConcurrency"),
							hint: t("probeConcurrencyHint"),
							value: form.maxConcurrentProbes,
							testId: "field-maxConcurrentProbes",
							type: "number",
							min: 1,
							max: 8,
							step: 1,
							onChange: (value) => {
								setSaved(false);
								setForm({
									...form,
									maxConcurrentProbes: value
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ip_pool_module_css_default.ghostButton,
							"data-testid": "probe-all",
							disabled: actionBusy || !form.enabled,
							onClick: () => {
								bridgeAction({ scope: "all" });
							},
							children: probing ? t("probeRunning").replace("{done}", String(probeDone)).replace("{total}", String(probeTotal)) : t("probeAll")
						})
					]
				}),
				form.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: ip_pool_module_css_default.field,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.fieldLabel,
						children: t("sectionExits")
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExitTable, {
					status,
					t,
					busy: actionBusy,
					onProbe: (id) => {
						bridgeAction({
							scope: "exit",
							exitId: id
						});
					},
					onPin: (id) => {
						pinExit(id);
					}
				})] }),
				statusError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.saveStatusError,
					children: statusError
				}),
				saved && error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `${ip_pool_module_css_default.saveStatus} ${ip_pool_module_css_default.saveStatusOk}`,
					children: t("saved")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ip_pool_module_css_default.compliance,
					children: t("copyCompliance")
				})
			]
		})
	});
}
/**
* The IP 池 page on the Plugins page (`plugins.item`).
*
* The Plugins page owns the card chrome and the save control: for
* `view: 'summary'` this returns the one-liner the page shows under the entry
* title, and for `view: 'page'` it returns the form bound to the entry's
* served settings.
*/
function IpPoolCard(props) {
	const { form, t, view } = props;
	if (view === "summary") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: t("description") });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardBody, {
		settings: form,
		t
	});
}

//#endregion
//#region src/client/ExitStatsEntry.tsx
/** Compact token label: 1_234_567 → 1.2M, 856 → 856. */
function compact(value) {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(value);
}
/** Clock label for a last-used stamp; 0 reads the never placeholder. */
function timeLabel(epoch, never) {
	if (epoch <= 0) return never;
	return new Date(epoch).toLocaleTimeString();
}
/** An exit is "usable" exactly where the pool's pick() would consider it:
*  probed healthy and not cooling (bans are per-model, so they don't hide a
*  whole row). */
function isUsable(exit) {
	return exit.state === "ok" && !exit.cooling;
}
/**
* The footer entry: one register()-mounted button plus its modal.
* @param props - sidebar column state, locale-bound `t`, standard seats.
* @returns the button and (when open) the portaled stats dialog.
*/
function ExitStatsEntry({ wide, t }) {
	const [status, setStatus] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const [failed, setFailed] = (0, react.useState)(false);
	const refresh = (0, react.useCallback)(async () => {
		try {
			const body = await (await fetch(`${BRIDGE_PREFIX}/status`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}"
			})).json();
			if (body.ok && body.value) {
				setStatus(body.value);
				setFailed(false);
			} else setFailed(true);
		} catch {
			setFailed(true);
		}
	}, []);
	(0, react.useEffect)(() => {
		refresh();
		const interval = setInterval(() => void refresh(), open ? 2e3 : 1e4);
		return () => clearInterval(interval);
	}, [open, refresh]);
	const rows = (0, react.useMemo)(() => [...status?.exits ?? []].sort((left, right) => right.requests - left.requests || left.latencyMs - right.latencyMs), [status]);
	const totals = (0, react.useMemo)(() => {
		const localRequests = status?.local?.requests ?? 0;
		const localTokens = status?.local?.tokens.totalTokens ?? 0;
		return {
			requests: (status?.exits ?? []).reduce((sum, exit) => sum + exit.requests, 0) + localRequests,
			tokens: (status?.exits ?? []).reduce((sum, exit) => sum + exit.tokens.totalTokens, 0) + localTokens,
			inFlight: (status?.exits ?? []).reduce((sum, exit) => sum + exit.inFlight, 0)
		};
	}, [status]);
	const usable = status?.availableTotal ?? 0;
	const total = status?.total ?? 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: ip_pool_module_css_default.footerEntry,
		onClick: () => setOpen(true),
		title: t("footerTitle"),
		"aria-haspopup": "dialog",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: ip_pool_module_css_default.footerIcon,
			"aria-hidden": "true",
			children: "◈"
		}), wide && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.footerText,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.footerMain,
				children: status === null ? t("footerDisabled") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [usable, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: ip_pool_module_css_default.footerUnit,
					children: [
						" / ",
						total,
						" ",
						t("footerLabel")
					]
				})] })
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: ip_pool_module_css_default.footerSub,
				children: [
					t("footerRequests", { count: totals.requests.toLocaleString() }),
					" · ",
					compact(totals.tokens),
					" tok"
				]
			})]
		})]
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose: () => setOpen(false),
		title: t("statsTitle"),
		closeLabel: t("statsClose"),
		description: t("statsDescription"),
		className: ip_pool_module_css_default.statsModal,
		contentClassName: ip_pool_module_css_default.statsContent,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: ip_pool_module_css_default.statsSummary,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("footerUsable", {
						usable,
						total
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("statsSummaryRequests", { count: totals.requests.toLocaleString() })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("statsSummaryTokens", { count: compact(totals.tokens) })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("statsSummaryInflight", { count: totals.inFlight })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("statsSummaryLocal", { count: (status?.local?.requests ?? 0).toLocaleString() })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.statsChip,
					children: t("statsSummaryDirect", { count: status?.direct.requests ?? 0 })
				})
			]
		}), rows.length === 0 && (status?.local?.requests ?? 0) === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: ip_pool_module_css_default.status,
			children: failed && status === null ? t("statsError") : t("statsEmpty")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: ip_pool_module_css_default.statsWrap,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
				className: ip_pool_module_css_default.statsTable,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColIp") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLocation") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColState") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColRequests") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColTokens") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLatency") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLastUsed") })
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [rows.map((exit) => {
					const usableRow = isUsable(exit);
					const dotClass = usableRow ? ip_pool_module_css_default.statsDotOk : exit.cooling ? ip_pool_module_css_default.statsDotWarn : ip_pool_module_css_default.statsDotBad;
					const stateLabel = usableRow ? t("statsStateUsable") : exit.cooling ? t("stateCooling") : exit.state === "dead" ? t("stateDead") : t("stateUnknown");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
						className: usableRow ? void 0 : ip_pool_module_css_default.statsRowMuted,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
								className: ip_pool_module_css_default.mono,
								children: [exit.exitIP || exit.id, exit.pinned ? ` · ${t("exitPinnedMark")}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.exitLocation || "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${ip_pool_module_css_default.statsDot} ${dotClass}`,
								"aria-hidden": "true"
							}), stateLabel] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.requests.toLocaleString() }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(exit.tokens.totalTokens) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : t("statsNever") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [exit.inFlight > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.statsInflight,
								children: t("statsInflight", { count: exit.inFlight })
							}), timeLabel(exit.lastUsedAt, t("statsNever"))] })
						]
					}, exit.id);
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
					className: ip_pool_module_css_default.statsRowLocal,
					"data-local-egress": true,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
							className: ip_pool_module_css_default.mono,
							children: t("statsLocalIp")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsLocalLocation") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `${ip_pool_module_css_default.statsDot} ${ip_pool_module_css_default.statsDotLocal}`,
							"aria-hidden": "true"
						}), t("statsLocalState")] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: (status?.local?.requests ?? 0).toLocaleString() }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(status?.local?.tokens.totalTokens ?? 0) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsNever") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: timeLabel(status?.local?.lastUsedAt ?? 0, t("statsNever")) })
					]
				})] })]
			})
		})]
	})] });
}

//#endregion
//#region src/client/locales.ts
/**
* The `settings.ip-pool` locale dictionaries for the IP 池 card (docs/ip-pool.md
* §5.2 block table). Keys track exactly the UI-surfaced strings.
*/
/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
	nav: "IP 池",
	title: "IP 池（opencode2dsh）",
	description: "多出口调度免费模型的可用性：出口间自动轮换、429 冷却、按出口×模型探活。",
	statusLoading: "加载中…",
	statusUnavailable: "设置服务不可用，无法读写 IP 池配置。",
	enabled: "启用 IP 池（enabled）",
	enabledHint: "关闭后全部流量直连，行为与本插件未装 IP 池时完全一致。",
	poolState: "池状态",
	poolStateHealthy: "健康",
	poolStateWarning: "偏低",
	poolStateCritical: "告急",
	poolStateEmergency: "枯竭",
	stateBasisFree: "口径：免费源池",
	stateBasisPool: "口径：全池（免费源已关闭）",
	poolAvailable: "池可用 {available}/{total}（其中免费源 {freeAvailable}/{capacity}）",
	poolSources: "出口来源：免费 {free} · 手填 {manual} · 订阅 {subscription}",
	pinnedBadge: "固定主力",
	deferredNotice: "路由已退避：{reason}",
	sectionFree: "免费源（free）",
	freeEnabled: "免费源抓取",
	freeEnabledHint: "从公共免费代理清单抓取并准入；关闭后只用下述两类出口。",
	freeTargetSize: "目标容量（targetSize）",
	freeTargetSizeHint: "免费池要补到的可用出口数（1-100，默认 20）。",
	freeBlockedCountries: "地理黑名单（blockedCountries）",
	freeBlockedCountriesHint: "ISO 国家码（逗号分隔），命中的出口不收。默认 CN。",
	refillNow: "立即补充",
	refillRunning: "补充中…",
	refillStageFetch: "① 拉取免费源清单",
	refillStageCoarse: "② 粗筛存活",
	refillStageAdmit: "③ 准入探测",
	refillStageIdle: "完成",
	refillCountSources: "已拉取 {done}/{total} 个源",
	refillCountFetched: "共 {n} 条",
	refillCountCoarse: "已筛 {done}/{total} · 存活 {passed}",
	refillCountAdmit: "已探 {done} · 入池 {admitted}",
	refillSummary: "上轮补充：入池 {admitted} 个（候选 {fetched}）",
	sectionManual: "手填代理（manual）",
	manualHint: "一行一个：http://host:port 或 socks5://host:port。适合自备节点/专线。",
	manualAdd: "添加代理",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "订阅（subscription）",
	subscriptionHint: "机场/自建 Clash·V2ray 订阅 URL，一行一个；明文节点直拨，加密节点经 sing-box 转换。",
	subscriptionAdd: "添加订阅",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "刷新间隔（毫秒）",
	subscriptionRefreshMsHint: "默认 1,800,000（30 分钟）。订阅只低频拉取，绝不并发轰炸。",
	subscriptionRefreshNow: "立即刷新",
	subscriptionUserAgent: "拉取 UA（subscription.userAgent）",
	subscriptionUserAgentHint: "拉订阅时发送的 User-Agent。机场常按它做白名单（不在名单里会返回错误页或 502），有的还按它决定返回哪种格式：Clash 形状给 YAML，v2ray 形状给 base64 链接。留空 = 内置默认值。",
	singboxPath: "sing-box 路径（singbox.path）",
	singboxPathHint: "加密节点的转换核心：PATH 名或绝对路径。未装则加密节点停在「待转换」。",
	sectionPinned: "固定主力出口（pinned）",
	pinnedAddress: "主力出口地址",
	pinnedAddressHint: "例如 Clash 混合端口 http://127.0.0.1:7897，或专线 http://host:port。即填即固定。",
	pinnedStrict: "绝对固定（pinnedStrict）",
	pinnedStrictHint: "开启后失败原样透传：不换出口、不直连。适合「这个出口必须用」的场景。",
	pinnedStrictOn: "绝对固定：失败也不换、不直连",
	pinnedStrictOff: "主力+备胎：429/断线自动切换，恢复后回归",
	pinnedUnset: "解除固定",
	sectionProbe: "探活（probe）",
	probeModels: "探活模型（probeModels）",
	probeModelsHint: "从列表选择探活模型；不选 = 默认 big-pickle。同一出口内多模型串行探测。",
	probeModelPick: "选择模型…",
	probeModelUnverified: "未验证",
	probeModelsDefault: "当前使用默认探活模型：big-pickle（S3 已验证清单首个）。",
	probeConcurrency: "并发上限（maxConcurrentProbes）",
	probeConcurrencyHint: "不同出口并发探测的上限（1-8，默认 3）；同一出口永远串行。",
	probeAll: "批量探活",
	probeRunning: "探活中 {done}/{total}…",
	sectionExits: "出口列表",
	exitAddress: "地址",
	exitSource: "来源",
	exitLocation: "位置",
	exitLatency: "延迟",
	exitQuality: "质量",
	exitIp: "出口 IP",
	exitState: "状态",
	exitPassive: "真实流量",
	stateOk: "ok",
	stateCooling: "冷却中",
	stateDead: "dead",
	stateUnknown: "未探活",
	exitProbe: "探测",
	exitPin: "固定为主力",
	exitPinnedMark: "主力",
	sectionBans: "模型封禁列表",
	bansEmpty: "没有已封禁的 (出口 × 模型) 对。",
	banBanned: "已封禁",
	banSuspect: "疑似",
	copyCompliance: "匿名配额受上游限流；多出口不绕过配额，只在出口间调度。固定/订阅节点优先；公共免费代理有安全与合规风险。",
	footerLabel: "出口",
	footerTitle: "IP 池出口统计",
	footerUsable: "可用 {usable}/{total}",
	footerRequests: "{count} 请求",
	footerDisabled: "IP 池未启用",
	statsTitle: "出口 IP 统计",
	statsDescription: "进程内累计（重启清零），出口按请求数排序。",
	statsClose: "关闭",
	statsSummaryRequests: "请求 {count}",
	statsSummaryTokens: "Token {count}",
	statsSummaryInflight: "在途 {count}",
	statsSummaryLocal: "本机 {count}",
	statsSummaryDirect: "直连兜底 {count} 次",
	statsColIp: "出口 IP",
	statsColLocation: "位置",
	statsColState: "状态",
	statsColRequests: "请求数",
	statsColTokens: "Token",
	statsColLatency: "延迟",
	statsColLastUsed: "最后使用",
	statsStateUsable: "可用",
	statsLocalIp: "本机",
	statsLocalLocation: "本机直连",
	statsLocalState: "未走出口",
	statsInflight: "在途×{count}",
	statsNever: "—",
	statsEmpty: "暂无出口数据：IP 池未启用或尚未准入出口。",
	statsError: "统计获取失败",
	save: "保存",
	saving: "保存中…",
	saved: "已保存，立即生效",
	saveError: "保存失败",
	readOnly: "当前配置为只读，无法保存修改。",
	invalidRange: "数值超出允许范围。",
	invalidProxy: "代理地址格式应为 http://host:port 或 socks5://host:port。",
	invalidUrl: "请填写合法的 http(s) URL。",
	invalidCountry: "国家码应为两个字母（如 CN），逗号分隔。",
	invalidModel: "模型 id 不能为空。",
	refreshError: "状态获取失败"
};
/** English dictionary, checked complete against the zh key set. */
const en = {
	nav: "IP Pool",
	title: "IP Pool (opencode2dsh)",
	description: "Schedules free-model availability across exit IPs: rotation, 429 cooldown, per-exit×model probes.",
	statusLoading: "Loading…",
	statusUnavailable: "Settings service unavailable; the IP pool configuration cannot be read or written.",
	enabled: "Enable IP pool (enabled)",
	enabledHint: "Off = every request goes direct, exactly as if the pool were not installed.",
	poolState: "Pool state",
	poolStateHealthy: "healthy",
	poolStateWarning: "low",
	poolStateCritical: "critical",
	poolStateEmergency: "depleted",
	stateBasisFree: "basis: free-source pool",
	stateBasisPool: "basis: whole pool (free source off)",
	poolAvailable: "{available}/{total} usable (free sources {freeAvailable}/{capacity})",
	poolSources: "Sources: free {free} · manual {manual} · subscription {subscription}",
	pinnedBadge: "pinned",
	deferredNotice: "Routing deferred: {reason}",
	sectionFree: "Free sources (free)",
	freeEnabled: "Free-source fetching",
	freeEnabledHint: "Fetch public free-proxy lists and admit survivors; off uses only the sources below.",
	freeTargetSize: "Target size (targetSize)",
	freeTargetSizeHint: "Usable free exits the pool refills to (1-100, default 20).",
	freeBlockedCountries: "Geo blocklist (blockedCountries)",
	freeBlockedCountriesHint: "ISO country codes, comma-separated; matching exits are refused. Default CN.",
	refillNow: "Refill now",
	refillRunning: "Refilling…",
	refillStageFetch: "① fetching source lists",
	refillStageCoarse: "② coarse screening",
	refillStageAdmit: "③ admission probes",
	refillStageIdle: "done",
	refillCountSources: "{done}/{total} sources answered",
	refillCountFetched: "{n} rows",
	refillCountCoarse: "screened {done}/{total} · {passed} alive",
	refillCountAdmit: "probed {done} · admitted {admitted}",
	refillSummary: "last round: admitted {admitted} (of {fetched} candidates)",
	sectionManual: "Manual proxies (manual)",
	manualHint: "One per line: http://host:port or socks5://host:port. For your own nodes.",
	manualAdd: "Add proxy",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "Subscriptions (subscription)",
	subscriptionHint: "Airport/self-hosted Clash·V2ray subscription URLs, one per line; plaintext nodes dial directly, encrypted ones convert via sing-box.",
	subscriptionAdd: "Add subscription",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "Refresh interval (ms)",
	subscriptionRefreshMsHint: "Default 1,800,000 (30 min). Subscriptions are pulled gently, never fanned out.",
	subscriptionRefreshNow: "Refresh now",
	subscriptionUserAgent: "Fetch UA (subscription.userAgent)",
	subscriptionUserAgentHint: "User-Agent sent when pulling subscriptions. Airports commonly allow-list it (an unlisted one returns an error page or a 502), and some pick the returned format from it: a Clash-shaped UA yields YAML, a v2ray-shaped one yields base64 links. Empty = the built-in default.",
	singboxPath: "sing-box path (singbox.path)",
	singboxPathHint: "Conversion core for encrypted nodes: PATH name or absolute path. Without it they stay \"pending conversion\".",
	sectionPinned: "Pinned primary exit (pinned)",
	pinnedAddress: "Primary exit address",
	pinnedAddressHint: "e.g. a Clash mixed port http://127.0.0.1:7897, or a leased line. Pins on save.",
	pinnedStrict: "Absolute pinning (pinnedStrict)",
	pinnedStrictHint: "Failures pass through verbatim: no rotation, no direct fallback. For \"this exit must be used\".",
	pinnedStrictOn: "Absolute: never rotate, never direct",
	pinnedStrictOff: "Primary + fallback: rotate on 429/drop, return when recovered",
	pinnedUnset: "Unpin",
	sectionProbe: "Probing (probe)",
	probeModels: "Probe models (probeModels)",
	probeModelsHint: "Pick probe models from the list; none selected = default big-pickle. Multiple models stay serial per exit.",
	probeModelPick: "Pick a model…",
	probeModelUnverified: "unverified",
	probeModelsDefault: "Using the default probe model: big-pickle (first of the S3 verified list).",
	probeConcurrency: "Concurrency cap (maxConcurrentProbes)",
	probeConcurrencyHint: "Cross-exit probe cap (1-8, default 3); one exit is always serial.",
	probeAll: "Probe all",
	probeRunning: "Probing {done}/{total}…",
	sectionExits: "Exits",
	exitAddress: "Address",
	exitSource: "Source",
	exitLocation: "Location",
	exitLatency: "Latency",
	exitQuality: "Quality",
	exitIp: "Exit IP",
	exitState: "State",
	exitPassive: "Live traffic",
	stateOk: "ok",
	stateCooling: "cooling",
	stateDead: "dead",
	stateUnknown: "unprobed",
	exitProbe: "Probe",
	exitPin: "Pin",
	exitPinnedMark: "primary",
	sectionBans: "Model bans",
	bansEmpty: "No banned (exit × model) pairs.",
	banBanned: "banned",
	banSuspect: "suspect",
	copyCompliance: "Anonymous quota is upstream-rate-limited; multiple exits do not bypass quota, they schedule across it. Pinned/subscription nodes first; public free proxies carry security and compliance risk.",
	footerLabel: "exits",
	footerTitle: "IP pool exit stats",
	footerUsable: "{usable}/{total} usable",
	footerRequests: "{count} requests",
	footerDisabled: "IP pool off",
	statsTitle: "Exit IP stats",
	statsDescription: "Process-lifetime totals (reset on restart), exits sorted by request count.",
	statsClose: "Close",
	statsSummaryRequests: "{count} requests",
	statsSummaryTokens: "{count} tokens",
	statsSummaryInflight: "{count} in flight",
	statsSummaryLocal: "{count} local",
	statsSummaryDirect: "{count} direct fallbacks",
	statsColIp: "Exit IP",
	statsColLocation: "Location",
	statsColState: "State",
	statsColRequests: "Requests",
	statsColTokens: "Tokens",
	statsColLatency: "Latency",
	statsColLastUsed: "Last used",
	statsStateUsable: "usable",
	statsLocalIp: "This machine",
	statsLocalLocation: "local egress",
	statsLocalState: "no exit used",
	statsInflight: "{count} in flight",
	statsNever: "—",
	statsEmpty: "No exit data yet: the pool is off or has admitted no exits.",
	statsError: "Stats fetch failed",
	save: "Save",
	saving: "Saving…",
	saved: "Saved, applied live",
	saveError: "Save failed",
	readOnly: "This configuration is read-only; changes cannot be saved.",
	invalidRange: "A value is out of range.",
	invalidProxy: "Expected http://host:port or socks5://host:port.",
	invalidUrl: "Enter a valid http(s) URL.",
	invalidCountry: "Country codes are two letters (e.g. CN), comma-separated.",
	invalidModel: "Model id must not be empty.",
	refreshError: "Status fetch failed"
};

//#endregion
//#region src/client/index.ts
/** Dictionary namespace owned by this plugin. */
const NS = "settings.ip-pool";
/**
* The Host settings entry this page edits: the Loader entry id, which is the
* plugin name. The editable field inside it is `ipPool`.
*/
const SETTINGS_NAMESPACE = "opencode2dsh";
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
	}), "opencode2dsh: copy dictionaries");
	const slots = ctx.slots;
	ctx.inject(["configForms"], (formCtx) => {
		formCtx.effect(() => formCtx.configForms.whileServed([SETTINGS_NAMESPACE], () => {
			const row = slots.inject("plugins.row.config", () => {
				const disposers = ["@opencode2dsh/dsh-plugin", "opencode2dsh"].map((pkg) => slots.register({
					name: "plugins.row.config",
					key: `${pkg}#${SETTINGS_NAMESPACE}`,
					locale: NS
				}, IpPoolCard));
				return () => {
					for (const dispose of disposers) dispose();
				};
			});
			const legacy = slots.inject("plugins.item", () => {
				if (slots.spec("plugins.row.config") !== void 0) return () => {};
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
				row();
				legacy();
				footer();
			};
		}), "opencode2dsh: settings page");
	});
}

//#endregion
exports.NS = NS;
exports.SETTINGS_NAMESPACE = SETTINGS_NAMESPACE;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map