window.__ModuleLoader__.load({ id: "dsh-opencode-free-provider", factory: (require) => {
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

//#region \0dsh-css:/Users/ankh/workspace/private/dsh-plugins/dsh-ocz-provider/src/client/ip-pool.module.css.mjs
const css = ".yHpP0q_body{flex-direction:column;gap:14px;display:flex}.yHpP0q_status{color:var(--dsw-alias-label-tertiary,#6b7280);margin:4px 0;font-size:13px;line-height:1.5}.yHpP0q_field{flex-direction:column;gap:6px;display:flex}.yHpP0q_fieldRow{grid-template-columns:1fr 1fr;gap:12px 16px;display:grid}@media (width<=720px){.yHpP0q_fieldRow{grid-template-columns:1fr}}.yHpP0q_fieldLabel{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:500}.yHpP0q_fieldHint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:1.5}.yHpP0q_fieldHead{align-items:center;gap:10px;display:flex}.yHpP0q_fieldHead>.yHpP0q_fieldLabel{flex:auto;min-width:0}.yHpP0q_fieldHeadAction{flex:none}.yHpP0q_fieldControl{width:100%;display:flex}.yHpP0q_inputWrapInvalid{border-color:var(--dsw-alias-state-error-primary,#d1242f);outline:1px solid var(--dsw-alias-state-error-primary,#d1242f);outline-offset:-1px}.yHpP0q_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);width:100%;color:var(--dsw-alias-label-primary,#1f2329);color-scheme:light;border-radius:6px;padding:6px 8px;font-size:13px}.yHpP0q_input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-1px}body[data-ds-dark-theme] .yHpP0q_input,body[data-ds-dark-theme] .yHpP0q_select,body[data-ds-dark-theme] .yHpP0q_textarea{color-scheme:dark}.yHpP0q_headerValue{overflow-wrap:anywhere;white-space:pre-wrap}.yHpP0q_textarea{resize:vertical;min-height:56px;font-family:inherit;line-height:1.5;}.yHpP0q_select{appearance:none;cursor:pointer;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5'%3E%3Cpath d='M4 6L8 10L12 6'/%3E%3C/svg%3E\");background-position:right 8px center;background-repeat:no-repeat;padding-right:24px;}.yHpP0q_saveStatus{font-size:12px;line-height:1.4}.yHpP0q_saveStatusOk{color:var(--dsw-alias-state-success-primary,#1a7f37)}.yHpP0q_saveStatusError{color:var(--dsw-alias-state-error-primary,#d1242f)}.yHpP0q_settingRow{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:16px;padding:12px 14px;display:flex}.yHpP0q_settingRowText{flex-direction:column;gap:2px;min-width:0;display:flex}.yHpP0q_settingRowTitle{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:600}.yHpP0q_settingRowControl{flex:none;align-items:center;padding-top:2px;display:flex}.yHpP0q_group{border-top:1px solid var(--dsw-alias-border-l2,#d0d7de);flex-direction:column;padding:6px 0 10px;display:flex}.yHpP0q_groupSummary{text-overflow:ellipsis;white-space:nowrap;max-width:60%;color:var(--dsw-alias-label-tertiary,#6b7280);margin-left:auto;padding-right:2px;font-size:12px;overflow:hidden}.yHpP0q_groupBody{flex-direction:column;gap:12px;padding:8px 0 4px 22px;display:flex}.yHpP0q_groupBodyHidden{display:none}.yHpP0q_groupHighlight{animation:1.2s yHpP0q_group-flash}@keyframes yHpP0q_group-flash{20%{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4f8cff)}}.yHpP0q_listItems{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.yHpP0q_listItem{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:6px;align-items:center;gap:8px;padding:4px 6px 4px 10px;display:flex}.yHpP0q_listItemText{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);flex:1 1 0;font-size:13px;overflow:hidden}.yHpP0q_listItem>button{min-width:22px;height:22px;padding:0 4px}.yHpP0q_listItemNew{animation:.4s yHpP0q_list-flash}@keyframes yHpP0q_list-flash{30%{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#1a7f37) 10%, transparent)}}.yHpP0q_listAddRow{align-items:center;gap:8px;display:flex}.yHpP0q_listAddInput{flex:1 1 0;min-width:0}.yHpP0q_listAddRow>button{height:32px}.yHpP0q_listDup{color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px}.yHpP0q_chipRow{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.yHpP0q_chip{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);max-width:240px;color:var(--dsw-alias-label-primary,#1f2329);border-radius:999px;align-items:center;gap:2px;padding:2px 4px 2px 10px;font-size:12px;display:inline-flex}.yHpP0q_chipText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.yHpP0q_chipSub{color:var(--dsw-alias-label-tertiary,#6b7280);margin-left:4px;font-size:11px}.yHpP0q_chip>button{min-width:20px;height:20px;padding:0 4px}.yHpP0q_overviewBar{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);border-radius:8px;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 10px;font-size:12px;display:flex}.yHpP0q_table{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;display:block;overflow-x:auto}.yHpP0q_tableGrid{border-collapse:collapse;width:100%;font-size:12px}.yHpP0q_tableGrid th,.yHpP0q_tableGrid td{border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);text-align:left;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;padding:6px 8px}.yHpP0q_tableGrid th{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-layer-2,#f6f8fa);font-weight:600}.yHpP0q_tableGrid tr:last-child td{border-bottom:none}.yHpP0q_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.yHpP0q_stateCell{align-items:center;gap:6px;display:inline-flex}.yHpP0q_stateOk{color:var(--dsw-alias-state-success-primary,#1a7f37)}.yHpP0q_stateCooling{color:var(--dsw-alias-state-warning-primary,#9a6700)}.yHpP0q_stateDead{color:var(--dsw-alias-state-error-primary,#d1242f)}.yHpP0q_stateUnknown{color:var(--dsw-alias-label-tertiary,#6b7280)}.yHpP0q_section{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fe80);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}.yHpP0q_rowList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}.yHpP0q_row{align-items:center;gap:6px;display:flex}.yHpP0q_rowLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);flex:1 1 0;font-size:13px;overflow:hidden}.yHpP0q_compliance{color:var(--dsw-alias-label-tertiary,#6b7280);border-top:1px dashed var(--dsw-alias-border-l2,#d0d7de);padding-top:10px;font-size:11px;line-height:1.5}.yHpP0q_collapseToggle{color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;background:0 0;border:none;align-self:flex-start;padding:2px 8px;font-size:12px}@media (prefers-reduced-motion:reduce){.yHpP0q_groupHighlight,.yHpP0q_listItemNew{animation:none}.yHpP0q_listItemNew{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#1a7f37) 10%, transparent)}}.yHpP0q_footerEntry{width:100%;color:var(--dsw-alias-label-primary,#1f2329);text-align:left;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:12px;display:flex;container-type:inline-size}.yHpP0q_footerEntry:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-color:var(--dsw-alias-border-l2,#d0d7de)}.yHpP0q_footerIcon{color:var(--dsw-alias-state-business-primary,#4f8cff);font-size:14px;line-height:1}.yHpP0q_footerText{flex-direction:column;min-width:0;display:flex}.yHpP0q_footerMain{white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600;line-height:1.25;overflow:hidden}.yHpP0q_footerUnit{color:var(--dsw-alias-label-secondary,#4b5563);font-weight:400}.yHpP0q_footerSub{color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.yHpP0q_footerEntryCompact{justify-content:center;gap:4px;padding:6px 4px}.yHpP0q_footerCompact{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.yHpP0q_footerCompactOnNarrow{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;flex-direction:column;align-items:flex-start;min-width:0;font-size:11px;display:none;overflow:hidden}.yHpP0q_footerCompactLine{text-overflow:ellipsis;max-width:100%;line-height:1.3;overflow:hidden}@container (width<=180px){.yHpP0q_footerText{display:none}.yHpP0q_footerCompactOnNarrow{display:flex}}.yHpP0q_tabBar{border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:7px;margin-bottom:10px;display:inline-flex;overflow:hidden}.yHpP0q_tab{background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border:none;padding:4px 14px;font-size:12px}.yHpP0q_tab+.yHpP0q_tab{border-left:1px solid var(--dsw-alias-border-l2,#d0d7de)}.yHpP0q_tab:hover{color:var(--dsw-alias-state-business-primary,#4f8cff)}.yHpP0q_tabActive{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600}.yHpP0q_usagePanel{flex-direction:column;gap:14px;display:flex}.yHpP0q_usageScopeChip{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff);font-weight:600}.yHpP0q_usageSection{flex-direction:column;gap:6px;display:flex}.yHpP0q_usageSectionTitle{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;font-weight:600}.yHpP0q_dayList{flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;display:flex}.yHpP0q_dayRow{grid-template-columns:44px 1fr 76px 60px;align-items:center;gap:8px;font-size:12px;display:grid}.yHpP0q_dayLabel{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#6b7280)}.yHpP0q_dayTrack{background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:5px;height:10px;overflow:hidden}.yHpP0q_dayBar{background:var(--dsw-alias-state-business-primary,#4f8cff);border-radius:5px;height:100%;display:block}.yHpP0q_dayValue{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2329)}.yHpP0q_dayRequests{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#6b7280)}.yHpP0q_usageTableWrap{overflow-x:hidden}.yHpP0q_usageTable{border-collapse:collapse;table-layout:fixed;width:100%;font-size:12px}.yHpP0q_usageTable th:first-child{width:40%}.yHpP0q_usageTable th:nth-child(2){width:18%}.yHpP0q_usageTable th:nth-child(3),.yHpP0q_usageTable th:nth-child(4){width:12%}.yHpP0q_usageTable th:nth-child(5){width:18%}.yHpP0q_usageTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#6b7280);border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);padding:5px 8px;font-weight:600}.yHpP0q_usageTable td{border-bottom:1px solid var(--dsw-alias-border-l3,#eaeef2);color:var(--dsw-alias-label-primary,#1f2329);text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;overflow:hidden}.yHpP0q_usageTable tbody tr:hover td{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}.yHpP0q_sessionLabel,.yHpP0q_projectLabel{text-overflow:ellipsis;vertical-align:bottom;max-width:100%;display:inline-block;overflow:hidden}.yHpP0q_projectList{flex-direction:column;gap:4px;margin:0;padding:0;font-size:12px;list-style:none;display:flex}.yHpP0q_projectRow{align-items:baseline;gap:10px;display:flex}.yHpP0q_projectMeta{color:var(--dsw-alias-label-tertiary,#6b7280)}.yHpP0q_usageClear{align-items:center;gap:6px;margin-left:auto;display:inline-flex}.yHpP0q_usageClearPrompt{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px}.yHpP0q_usageClearDanger{border:1px solid var(--dsw-alias-state-error-primary,#d1242f);background:var(--dsw-alias-state-error-primary,#d1242f);color:#fff;cursor:pointer;border-radius:6px;padding:6px 12px;font-size:13px}.yHpP0q_usageClearDanger:disabled{opacity:.6;cursor:default}.yHpP0q_usageFootnote{color:var(--dsw-alias-label-tertiary,#6b7280);margin:0;font-size:11px}.yHpP0q_statsSummary{flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px;display:flex}.yHpP0q_statsChip{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap;border-radius:999px;align-items:center;padding:2px 8px;font-size:11px;line-height:18px;display:inline-flex}.yHpP0q_statsModal.yHpP0q_statsModal{width:min(1040px,100%);height:min(640px,100%);max-height:100%}.yHpP0q_statsContent{flex:auto;min-height:0;overflow-y:auto}.yHpP0q_statsWrap{overflow-x:hidden}.yHpP0q_statsTable{table-layout:fixed;border-collapse:collapse;width:100%;font-size:12px}.yHpP0q_statsTable th:first-child{width:22%}.yHpP0q_statsTable th:nth-child(2){width:7%}.yHpP0q_statsTable th:nth-child(3){width:9%}.yHpP0q_statsTable th:nth-child(4){width:8%}.yHpP0q_statsTable th:nth-child(5){width:7%}.yHpP0q_statsTable th:nth-child(6){width:10%}.yHpP0q_statsTable th:nth-child(7),.yHpP0q_statsTable th:nth-child(8){width:7%}.yHpP0q_statsTable th:nth-child(9){width:11%}.yHpP0q_statsTable th:nth-child(10){width:12%}.yHpP0q_statsTable th{text-align:left;color:var(--dsw-alias-label-tertiary,#6b7280);border-bottom:1px solid var(--dsw-alias-border-l2,#d0d7de);white-space:normal;padding:6px 8px;font-weight:600}.yHpP0q_statsSortButton{font:inherit;color:inherit;cursor:pointer;background:0 0;border:0;align-items:center;gap:3px;padding:0;display:inline-flex}.yHpP0q_statsSortButton:hover{color:var(--dsw-alias-label-primary,#1f2329)}.yHpP0q_statsSortButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4f8cff);outline-offset:1px;border-radius:3px}.yHpP0q_statsSortArrow{text-align:center;min-width:10px;font-size:9px;line-height:1}.yHpP0q_statsTable td{border-bottom:1px solid var(--dsw-alias-border-l3,#eaeef2);color:var(--dsw-alias-label-primary,#1f2329);white-space:normal;overflow-wrap:anywhere;padding:6px 8px}.yHpP0q_statsRowMuted td{color:var(--dsw-alias-label-tertiary,#6b7280)}.yHpP0q_statsTable tbody tr:hover td,.yHpP0q_tableGrid tbody tr:hover td{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}.yHpP0q_statsRowLocal td{border-top:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#4b5563);border-bottom:none;font-weight:500}.yHpP0q_statsEndpoint{color:var(--dsw-alias-label-tertiary,#6b7280);white-space:nowrap;margin-left:6px;font-size:.86em}.yHpP0q_statsDot{vertical-align:middle;border-radius:50%;width:7px;height:7px;margin-right:5px;display:inline-block}.yHpP0q_statsDotOk{background:var(--dsw-alias-state-success-primary,#1a7f37)}.yHpP0q_statsDotWarn{background:var(--dsw-alias-state-warning-primary,#9a6700)}.yHpP0q_statsDotBad{background:var(--dsw-alias-state-error-primary,#d1242f)}.yHpP0q_statsRegion{font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap}.yHpP0q_statsActions{white-space:nowrap}.yHpP0q_rowAction{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:5px;justify-content:center;align-items:center;padding:3px 5px;line-height:0;display:inline-flex}.yHpP0q_rowAction:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.yHpP0q_rowAction:disabled{opacity:.5;cursor:default}.yHpP0q_rowActionActive,.yHpP0q_rowActionActive:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff}.yHpP0q_rowIcon{border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;border-radius:6px;align-items:center;padding:4px 7px;line-height:0;display:inline-flex}.yHpP0q_rowIcon:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff)}.yHpP0q_rowIcon:disabled{opacity:.5;cursor:default}.yHpP0q_actionGroup{vertical-align:middle;display:inline-flex}.yHpP0q_actionGroup>button+button{margin-left:-1px}.yHpP0q_actionGroup>button:not(:first-child){border-top-left-radius:0;border-bottom-left-radius:0}.yHpP0q_actionGroup>button:not(:last-child){border-top-right-radius:0;border-bottom-right-radius:0}.yHpP0q_actionGroup>button:hover:not(:disabled),.yHpP0q_actionGroup>button:focus-visible{z-index:1;position:relative}.yHpP0q_tableGrid td>*+*{margin-left:4px}.yHpP0q_statsToast{z-index:2;background:var(--dsw-alias-toast-bg,#1f2937);max-width:min(360px,100% - 40px);color:var(--dsw-alias-toast-label,#f9fafb);box-shadow:var(--dsw-shadow-lv3,0 8px 24px #0000002e);animation:yHpP0q_stats-toast-in .16s ease-out, yHpP0q_stats-toast-fade .3s ease var(--stats-toast-hold,3s) forwards;border-radius:8px;padding:8px 14px;font-size:12px;line-height:1.5;position:absolute;bottom:20px;right:20px}.yHpP0q_statsToastWarn{color:var(--dsw-alias-state-warning-primary,#d29922)}@keyframes yHpP0q_stats-toast-in{0%{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes yHpP0q_stats-toast-fade{to{opacity:0;visibility:hidden}}@media (prefers-reduced-motion:reduce){.yHpP0q_statsToast{animation:yHpP0q_stats-toast-fade .3s ease var(--stats-toast-hold,3s) forwards}}.yHpP0q_statsInflight{background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff;border-radius:999px;margin-right:6px;padding:0 6px;font-size:10px;line-height:1.6;display:inline-block}";
const tagId = "dsh-opencode-free-provider/ip-pool.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-opencode-free-provider";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var ip_pool_module_css_default = {
	"actionGroup": "yHpP0q_actionGroup",
	"body": "yHpP0q_body",
	"chip": "yHpP0q_chip",
	"chipRow": "yHpP0q_chipRow",
	"chipSub": "yHpP0q_chipSub",
	"chipText": "yHpP0q_chipText",
	"collapseToggle": "yHpP0q_collapseToggle",
	"compliance": "yHpP0q_compliance",
	"dayBar": "yHpP0q_dayBar",
	"dayLabel": "yHpP0q_dayLabel",
	"dayList": "yHpP0q_dayList",
	"dayRequests": "yHpP0q_dayRequests",
	"dayRow": "yHpP0q_dayRow",
	"dayTrack": "yHpP0q_dayTrack",
	"dayValue": "yHpP0q_dayValue",
	"field": "yHpP0q_field",
	"fieldControl": "yHpP0q_fieldControl",
	"fieldHead": "yHpP0q_fieldHead",
	"fieldHeadAction": "yHpP0q_fieldHeadAction",
	"fieldHint": "yHpP0q_fieldHint",
	"fieldLabel": "yHpP0q_fieldLabel",
	"fieldRow": "yHpP0q_fieldRow",
	"footerCompact": "yHpP0q_footerCompact",
	"footerCompactLine": "yHpP0q_footerCompactLine",
	"footerCompactOnNarrow": "yHpP0q_footerCompactOnNarrow",
	"footerEntry": "yHpP0q_footerEntry",
	"footerEntryCompact": "yHpP0q_footerEntryCompact",
	"footerIcon": "yHpP0q_footerIcon",
	"footerMain": "yHpP0q_footerMain",
	"footerSub": "yHpP0q_footerSub",
	"footerText": "yHpP0q_footerText",
	"footerUnit": "yHpP0q_footerUnit",
	"group": "yHpP0q_group",
	"group-flash": "yHpP0q_group-flash",
	"groupBody": "yHpP0q_groupBody",
	"groupBodyHidden": "yHpP0q_groupBodyHidden",
	"groupHighlight": "yHpP0q_groupHighlight",
	"groupSummary": "yHpP0q_groupSummary",
	"headerValue": "yHpP0q_headerValue",
	"input": "yHpP0q_input",
	"inputWrapInvalid": "yHpP0q_inputWrapInvalid",
	"list-flash": "yHpP0q_list-flash",
	"listAddInput": "yHpP0q_listAddInput",
	"listAddRow": "yHpP0q_listAddRow",
	"listDup": "yHpP0q_listDup",
	"listItem": "yHpP0q_listItem",
	"listItemNew": "yHpP0q_listItemNew",
	"listItemText": "yHpP0q_listItemText",
	"listItems": "yHpP0q_listItems",
	"mono": "yHpP0q_mono",
	"overviewBar": "yHpP0q_overviewBar",
	"projectLabel": "yHpP0q_projectLabel",
	"projectList": "yHpP0q_projectList",
	"projectMeta": "yHpP0q_projectMeta",
	"projectRow": "yHpP0q_projectRow",
	"row": "yHpP0q_row",
	"rowAction": "yHpP0q_rowAction",
	"rowActionActive": "yHpP0q_rowActionActive",
	"rowIcon": "yHpP0q_rowIcon",
	"rowLabel": "yHpP0q_rowLabel",
	"rowList": "yHpP0q_rowList",
	"saveStatus": "yHpP0q_saveStatus",
	"saveStatusError": "yHpP0q_saveStatusError",
	"saveStatusOk": "yHpP0q_saveStatusOk",
	"section": "yHpP0q_section",
	"select": "yHpP0q_select",
	"sessionLabel": "yHpP0q_sessionLabel",
	"settingRow": "yHpP0q_settingRow",
	"settingRowControl": "yHpP0q_settingRowControl",
	"settingRowText": "yHpP0q_settingRowText",
	"settingRowTitle": "yHpP0q_settingRowTitle",
	"stateCell": "yHpP0q_stateCell",
	"stateCooling": "yHpP0q_stateCooling",
	"stateDead": "yHpP0q_stateDead",
	"stateOk": "yHpP0q_stateOk",
	"stateUnknown": "yHpP0q_stateUnknown",
	"stats-toast-fade": "yHpP0q_stats-toast-fade",
	"stats-toast-in": "yHpP0q_stats-toast-in",
	"statsActions": "yHpP0q_statsActions",
	"statsChip": "yHpP0q_statsChip",
	"statsContent": "yHpP0q_statsContent",
	"statsDot": "yHpP0q_statsDot",
	"statsDotBad": "yHpP0q_statsDotBad",
	"statsDotOk": "yHpP0q_statsDotOk",
	"statsDotWarn": "yHpP0q_statsDotWarn",
	"statsEndpoint": "yHpP0q_statsEndpoint",
	"statsInflight": "yHpP0q_statsInflight",
	"statsModal": "yHpP0q_statsModal",
	"statsRegion": "yHpP0q_statsRegion",
	"statsRowLocal": "yHpP0q_statsRowLocal",
	"statsRowMuted": "yHpP0q_statsRowMuted",
	"statsSortArrow": "yHpP0q_statsSortArrow",
	"statsSortButton": "yHpP0q_statsSortButton",
	"statsSummary": "yHpP0q_statsSummary",
	"statsTable": "yHpP0q_statsTable",
	"statsToast": "yHpP0q_statsToast",
	"statsToastWarn": "yHpP0q_statsToastWarn",
	"statsWrap": "yHpP0q_statsWrap",
	"status": "yHpP0q_status",
	"tab": "yHpP0q_tab",
	"tabActive": "yHpP0q_tabActive",
	"tabBar": "yHpP0q_tabBar",
	"table": "yHpP0q_table",
	"tableGrid": "yHpP0q_tableGrid",
	"textarea": "yHpP0q_textarea",
	"usageClear": "yHpP0q_usageClear",
	"usageClearDanger": "yHpP0q_usageClearDanger",
	"usageClearPrompt": "yHpP0q_usageClearPrompt",
	"usageFootnote": "yHpP0q_usageFootnote",
	"usagePanel": "yHpP0q_usagePanel",
	"usageScopeChip": "yHpP0q_usageScopeChip",
	"usageSection": "yHpP0q_usageSection",
	"usageSectionTitle": "yHpP0q_usageSectionTitle",
	"usageTable": "yHpP0q_usageTable",
	"usageTableWrap": "yHpP0q_usageTableWrap"
};

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
//#region src/request-headers.ts
const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
/** Headers the plugin owns: authentication, cookies, framing and body format. */
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
	"accept-encoding"
]);
const MAX_HEADERS = 32;
const MAX_BYTES = 8192;
/** One accepted entry, or undefined when the pair must be dropped. */
function accept(rawName, rawValue) {
	if (typeof rawName !== "string") return void 0;
	const name = rawName.toLowerCase();
	if (!HEADER_NAME.test(name) || MANAGED_HEADERS.has(name)) return void 0;
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
		if (MANAGED_HEADERS.has(name)) throw new Error(`Header is managed by the plugin: ${name}`);
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
//#region src/client/RequestHeadersEditor.tsx
/**
* Zen headers editor body — no section chrome of its own: the collapsible
* 「Zen 请求头」 group supplies the title, so this renders only the field,
* its hint and the effective-UA readout.
*/
function RequestHeadersEditor(props) {
	const { text, effectiveUserAgent, disabled, t, onChange } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
			className: ip_pool_module_css_default.field,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: t("requestHeadersLabel")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				className: ip_pool_module_css_default.textarea,
				"data-testid": "field-requestHeaders",
				"aria-describedby": "zen-headers-hint",
				rows: 4,
				spellCheck: false,
				disabled,
				value: text,
				placeholder: "User-Agent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/node.js/24\nx-opencode-client: desktop",
				onChange: (event) => onChange(event.target.value)
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			id: "zen-headers-hint",
			className: ip_pool_module_css_default.fieldHint,
			children: t("requestHeadersHint")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			className: ip_pool_module_css_default.status,
			"data-testid": "zen-effective-user-agent",
			"aria-live": "polite",
			children: [
				t("requestHeadersEffectiveUA"),
				" ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
					className: ip_pool_module_css_default.headerValue,
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
/** The bridge prefix (same-origin, loopback-only on the host). */
const BRIDGE_PREFIX = "/api/oc2dsh/ip-pool";
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
	usageScope: "total"
};
/** Compact all-in token label for the usage chips (input+output+cache). */
function usageTokens(tokens) {
	const value = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(value);
}
/** Subscription URLs never render in full — the settings doc is the only
*  place they exist in plaintext (docs §5.1 redaction boundary). */
function redactUrl(url) {
	if (url.length <= 24) return url;
	return url.slice(0, 12) + "…" + url.slice(-6);
}
function emptyForm() {
	return {
		enabled: DEFAULTS.enabled,
		manual: [],
		subscriptionUrls: [],
		refreshMs: String(DEFAULTS.subscription.refreshMs),
		userAgent: DEFAULTS.subscription.userAgent,
		singboxPath: DEFAULTS.singbox.path,
		pinnedExitId: "",
		pinnedStrict: DEFAULTS.pinnedStrict,
		probeModels: [],
		probeContents: [],
		maxConcurrentProbes: String(DEFAULTS.maxConcurrentProbes),
		poolSize: String(DEFAULTS.poolSize),
		usageScope: DEFAULTS.usageScope
	};
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
		probeModels: [...value.probeModels],
		probeContents: [...value.probeContents ?? []],
		maxConcurrentProbes: String(value.maxConcurrentProbes),
		poolSize: String(value.poolSize ?? DEFAULTS.poolSize),
		usageScope: value.usageScope === "run" ? "run" : "total"
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
	push("probeContents", form.probeContents, value.probeContents, base.probeContents);
	push("maxConcurrentProbes", Number(form.maxConcurrentProbes), value.maxConcurrentProbes, base.maxConcurrentProbes);
	push("poolSize", Number(form.poolSize), value.poolSize, base.poolSize);
	push("usageScope", form.usageScope, value.usageScope, base.usageScope);
	return writes;
}
/** Clearing the UA field restores the default instead of writing an empty
*  header — the Host schema and the runtime both treat empty as "default",
*  and this keeps a cleared field from looking like a pending change. */
function normalizedUserAgent(value) {
	const trimmed = value.trim();
	return trimmed === "" ? DEFAULTS.subscription.userAgent : trimmed;
}
/** One labeled input (the Input primitive carries the box chrome). */
function TextField(props) {
	const { label, hint, value, onChange, placeholder, testId, type = "text", min, max, step, invalid, disabled, action } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: ip_pool_module_css_default.field,
		children: [
			action == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: label
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: ip_pool_module_css_default.fieldHead,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.fieldLabel,
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.fieldHeadAction,
					children: action
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
				className: invalid === true ? `${ip_pool_module_css_default.fieldControl} ${ip_pool_module_css_default.inputWrapInvalid}` : ip_pool_module_css_default.fieldControl,
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
				className: ip_pool_module_css_default.fieldHint,
				children: hint
			})
		]
	});
}
/**
* One editable string list (manual proxies / subscription URLs / probe
* contents). Items are one-per-line capsule rows with a remove button; the
* add row is an Input + 添加 Button (Enter also adds). A duplicate add is
* refused with an inline note; a fresh add flashes the new row so the append
* is visible at the bottom of a long list.
*/
function ListEditor(props) {
	const { label, hint, values, placeholder, testId, redacted, disabled, t, onChange } = props;
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
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.field,
		"data-testid": testId,
		children: [
			label !== void 0 && label !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldLabel,
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: hint
			}),
			values.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: ip_pool_module_css_default.listItems,
				children: values.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: entry === fresh ? `${ip_pool_module_css_default.listItem} ${ip_pool_module_css_default.listItemNew}` : ip_pool_module_css_default.listItem,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.listItemText,
						title: redacted ? entry : void 0,
						children: redacted ? redactUrl(entry) : entry
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "ghost",
						size: "sm",
						disabled: disabled === true,
						"aria-label": t("listRemove"),
						title: t("listRemove"),
						onClick: () => {
							setDup(false);
							onChange(values.filter((v) => v !== entry));
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconCloseFillMedium, {})
					})]
				}, entry))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ip_pool_module_css_default.listAddRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Input, {
					className: ip_pool_module_css_default.listAddInput,
					value: draft,
					placeholder,
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
				className: ip_pool_module_css_default.listDup,
				role: "status",
				children: t("listExists")
			})
		]
	});
}
/**
* Probe-model picker over the bridge /models rows: selected models as
* removable chips above a dropdown of S3-verified + live-catalog options
* (docs §5.2 探活模型). Empty selection = the S3-first default (big-pickle).
*/
function ModelPicker(props) {
	const { value, hint, models, loading, disabled, t, onChange } = props;
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
			value.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ip_pool_module_css_default.chipRow,
				children: value.map((id) => {
					const row = models.find((m) => m.id === id);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: ip_pool_module_css_default.chip,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: ip_pool_module_css_default.chipText,
							children: [id, row?.verified === false && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.chipSub,
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
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
				className: ip_pool_module_css_default.select,
				"data-testid": "probe-model-select",
				value: "",
				disabled: disabled === true || options.length === 0,
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
			}),
			value.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.fieldHint,
				children: t("probeModelsDefault")
			})
		]
	});
}
/** Pool overview strip: Tag status badge + counts + pinned badge. */
function OverviewBar(props) {
	const { status, t } = props;
	if (status === null) return null;
	const stateLabel = {
		healthy: t("poolStateHealthy"),
		warning: t("poolStateWarning"),
		critical: t("poolStateCritical"),
		emergency: t("poolStateEmergency")
	};
	const stateTone = {
		healthy: "success",
		warning: "warning",
		critical: "danger",
		emergency: "danger"
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.overviewBar,
		"data-testid": "ip-pool-overview",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: stateTone[status.state],
				children: stateLabel[status.state]
			}),
			status.deferredReason !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: "danger",
				children: t("deferredNotice").replace("{reason}", status.deferredReason)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolAvailable").replace("{available}", String(status.availableTotal)).replace("{total}", String(status.total)).replace("{poolSize}", String(status.poolSize ?? status.targetSize)) }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("poolSources").replace("{manual}", String(status.bySource.manual)).replace("{subscription}", String(status.bySource.subscription)) }),
			status.pinned !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: "info",
				children: [status.pinned.local === true ? t("pinnedBadgeLocal") : t("pinnedBadge"), status.pinned.strict && status.pinned.local !== true ? " (" + t("pinnedStrict") + ")" : ""]
			})
		]
	});
}
/** The exit table + ban list. */
function ExitTable(props) {
	const { status, t, onProbe, onPin, onRotate, busy } = props;
	const [bansOpen, setBansOpen] = (0, react.useState)(false);
	if (status === null) return null;
	const stateCell = (exit) => {
		if (exit.state === "dead") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.stateCell,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" }), t("stateDead")]
		});
		if (exit.demoted === true) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.stateCell,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "warning" }), t("stateDemoted")]
		});
		if (exit.cooling) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.stateCell,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "warning" }), t("stateCooling")]
		});
		if (exit.state === "ok") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.stateCell,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "done" }), t("stateOk")]
		});
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: ip_pool_module_css_default.stateCell,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "idle" }), t("stateUnknown")]
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
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? exit.quality : "—" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: ip_pool_module_css_default.mono,
					title: exit.exitLocation || void 0,
					children: exit.exitIP || "—"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stateCell(exit) }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
					className: ip_pool_module_css_default.mono,
					children: exit.passive.ok > 0 || exit.passive.limited > 0 || exit.passive.refused > 0 || exit.passive.dead > 0 || exit.passive.transport > 0 ? `✓${exit.passive.ok} 429:${exit.passive.limited} 401/403:${exit.passive.refused} ✗:${exit.passive.dead + exit.passive.transport}` : "—"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => onProbe(exit.id),
					children: t("exitProbe")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: ip_pool_module_css_default.actionGroup,
					children: [!exit.pinned && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: ip_pool_module_css_default.rowIcon,
						disabled: busy,
						title: t("statsPinHint"),
						"aria-label": t("exitPin"),
						onClick: () => onPin(exit.id),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinIcon, {})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: ip_pool_module_css_default.rowIcon,
						disabled: busy,
						title: t("statsRotateHint"),
						"aria-label": t("statsRotate"),
						onClick: () => onRotate(exit.id),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RotateIcon, {})
					})]
				})] })
			] }, exit.id)), status.exits.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
				colSpan: 8,
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
/** First-visit fold state: high-frequency groups open, advanced ones folded. */
const GROUP_DEFAULTS = {
	sources: true,
	scheduling: false,
	probe: false,
	usage: true,
	headers: false,
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
* One collapsible settings group: a DisclosureRow header carrying the title
* plus a folded-state summary, and a body that stays MOUNTED while folded
* (display:none) so half-typed list drafts and focus survive a fold.
*/
function Group(props) {
	const { id, title, summary, open, highlight, onToggle, children } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: highlight ? `${ip_pool_module_css_default.group} ${ip_pool_module_css_default.groupHighlight}` : ip_pool_module_css_default.group,
		"data-group": id,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
			icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, {}),
			title,
			open,
			expandable: true,
			expandOnRowClick: true,
			onToggle,
			collapsedContent: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.groupSummary,
				children: summary
			})
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: open ? ip_pool_module_css_default.groupBody : ip_pool_module_css_default.groupBodyHidden,
			children
		})]
	});
}
/** The card body. */
function CardBody(props) {
	const { settings, t } = props;
	const snapshot = settings?.state;
	const [form, setForm] = (0, react.useState)(() => emptyForm());
	const [headersText, setHeadersText] = (0, react.useState)("");
	const [headerConflict, setHeaderConflict] = (0, react.useState)(false);
	const acceptedHeadersRef = (0, react.useRef)("");
	const [saving, setSaving] = (0, react.useState)(false);
	const [saved, setSaved] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)(null);
	const [statusError, setStatusError] = (0, react.useState)(null);
	const [probeModelRows, setProbeModelRows] = (0, react.useState)([]);
	const [probeModelsLoading, setProbeModelsLoading] = (0, react.useState)(false);
	const [actionBusy, setActionBusy] = (0, react.useState)(false);
	const [groups, setGroups] = (0, react.useState)(() => loadGroupState());
	const [highlightGroup, setHighlightGroup] = (0, react.useState)(null);
	const highlightTimer = (0, react.useRef)(null);
	const hydratedRef = (0, react.useRef)(false);
	const formRef = (0, react.useRef)(form);
	formRef.current = form;
	(0, react.useEffect)(() => {
		try {
			localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groups));
		} catch {}
	}, [groups]);
	(0, react.useEffect)(() => () => {
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
	}, []);
	const served = servedSection(snapshot);
	const servedRef = (0, react.useRef)(served);
	servedRef.current = served;
	(0, react.useEffect)(() => {
		if (snapshot?.status === "ready" && !hydratedRef.current) {
			hydratedRef.current = true;
			setForm(formFromValue(servedRef.current));
			const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot.value?.requestHeaders ?? {}));
			acceptedHeadersRef.current = headers;
			setHeadersText(headers);
		}
	}, [snapshot?.status, snapshot?.value]);
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
		if (snapshot?.status !== "ready" || !hydratedRef.current) return;
		refreshStatus();
		const interval = setInterval(() => void refreshStatus(), probing ? 1e3 : 3e3);
		return () => clearInterval(interval);
	}, [
		snapshot?.status,
		probing,
		refreshStatus,
		hydratedRef.current
	]);
	const validate = () => {
		const conc = Number(form.maxConcurrentProbes);
		if (!/^\d+$/.test(form.maxConcurrentProbes.trim()) || conc < 1 || conc > 8) return {
			message: t("invalidRange"),
			group: "probe"
		};
		const poolSize = Number(form.poolSize);
		if (!/^\d+$/.test(form.poolSize.trim()) || poolSize < 1 || poolSize > 100) return {
			message: t("invalidRange"),
			group: "probe"
		};
		const refresh = Number(form.refreshMs);
		if (!/^\d+$/.test(form.refreshMs.trim()) || refresh < 6e4) return {
			message: t("invalidRange"),
			group: "sources"
		};
		for (const entry of form.manual) if (!/^https?:\/\/[^\s:]+:\d{1,5}$|^socks5:\/\/[^\s:]+:\d{1,5}$|^socks5h?:\/\/\[[^\]]+\]:\d{1,5}$/.test(entry)) return {
			message: t("invalidProxy"),
			group: "sources"
		};
		for (const url of form.subscriptionUrls) if (!/^https?:\/\/.+/.test(url)) return {
			message: t("invalidUrl"),
			group: "sources"
		};
		for (const model of form.probeModels) if (model.trim() === "") return {
			message: t("invalidModel"),
			group: "probe"
		};
		return null;
	};
	const writes = diffWrites(formRef.current, served, servedBase(snapshot));
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
	const validation = headerFailure ?? validate();
	const dirty = writes.length > 0 || headerOps.length > 0 || validation !== null;
	const available = snapshot?.status === "ready" && settings !== void 0;
	const writable = available && snapshot.writable;
	(0, react.useEffect)(() => {
		if (validation === null) return;
		const group = validation.group;
		setGroups((current) => current[group] ? current : {
			...current,
			[group]: true
		});
		setHighlightGroup(group);
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
		highlightTimer.current = setTimeout(() => setHighlightGroup(null), 1200);
	}, [validation?.group, validation?.message]);
	if (snapshot?.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		className: ip_pool_module_css_default.status,
		children: t("statusLoading")
	});
	/** Toggle one group's fold state. */
	const toggleGroup = (group) => {
		setGroups((current) => ({
			...current,
			[group]: !current[group]
		}));
	};
	const handleSave = async () => {
		if (!writable || validation !== null || settings === void 0 || snapshot === void 0) {
			setSaved(false);
			setError(validation?.message ?? t("saveError"));
			return;
		}
		if (writes.length === 0 && headerOps.length === 0) {
			setSaved(true);
			setError(null);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const ok = await settings.mutate([...headerOps, ...poolWriteOps(writes)], snapshot.revision);
			setSaved(ok);
			setError(ok ? null : t("saveError"));
			if (ok && headerOps.length > 0) await refreshStatus();
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
		const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}));
		acceptedHeadersRef.current = headers;
		setHeadersText(headers);
		setHeaderConflict(false);
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
	/**
	* 轮换 one exit out of the table. The bridge owns the whole decision (promote
	* a reserve into its slot, or sink the row to the tail), so the card only
	* re-reads /status after it.
	*/
	const rotateExit = async (exitId) => {
		setActionBusy(true);
		try {
			await fetch(`${BRIDGE_PREFIX}/exit`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "rotate",
					exitId
				})
			});
			await refreshStatus();
		} catch {
			setStatusError(t("refreshError"));
		} finally {
			setActionBusy(false);
		}
	};
	/**
	* Switch the usage scope. Written IMMEDIATELY rather than as a form draft:
	* it is a view switch, not a configuration edit, and the numbers it governs
	* are read from the bridge — requiring a 保存 press to re-read them would be
	* a strange two-step for a control whose whole job is to change what you see.
	*/
	const setUsageScope = async (next) => {
		if (!writable || settings === void 0 || snapshot === void 0) return;
		setActionBusy(true);
		try {
			if (!await settings.mutate([{
				op: "set",
				path: [IP_POOL_FIELD, "usageScope"],
				value: next
			}], snapshot.revision)) throw new Error(t("saveError"));
			setForm((current) => ({
				...current,
				usageScope: next
			}));
			await refreshStatus();
		} catch (err) {
			setError(err instanceof Error ? err.message : t("saveError"));
		} finally {
			setActionBusy(false);
		}
	};
	const probeDone = status !== null ? status.prober.completed : 0;
	const probeTotal = status !== null ? status.prober.enqueued : 0;
	const sourcesSummary = [form.manual.length > 0 ? t("summaryProxies", { count: String(form.manual.length) }) : "", form.subscriptionUrls.length > 0 ? t("summarySubscriptions", { count: String(form.subscriptionUrls.length) }) : ""].filter((part) => part !== "").join(" · ") || t("summaryUnset");
	const schedulingSummary = form.pinnedExitId !== "" ? t("summaryPinned", { target: form.pinnedExitId }) : `${t("summaryAuto")}${form.pinnedStrict ? ` · ${t("pinnedModeAbsolute")}` : ""}`;
	const probeSummary = [
		form.probeModels.length === 0 ? t("summaryModelsDefault") : t("summaryModelsCount", { count: String(form.probeModels.length) }),
		form.probeContents.length > 0 ? t("summaryContentsCount", { count: String(form.probeContents.length) }) : "",
		t("summaryConcurrency", { count: form.maxConcurrentProbes }),
		t("summaryCapacity", { count: form.poolSize })
	].filter((part) => part !== "").join(" · ");
	const usageSummary = status?.usage == null ? t("summaryUsageNone") : t("summaryUsage", {
		requests: status.usage.scoped.requests.toLocaleString(),
		tokens: usageTokens(status.usage.scoped)
	});
	const headersLineCount = headersText.split("\n").filter((line) => line.trim() !== "").length;
	const headersSummary = headersLineCount === 0 ? t("summaryHeadersDefault") : t("summaryHeadersCustom", { count: String(headersLineCount) });
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
			className: ip_pool_module_css_default.body,
			"data-testid": "ip-pool-form",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.settingRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ip_pool_module_css_default.settingRowText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.settingRowTitle,
							children: t("enabled")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.fieldHint,
							children: t("enabledHint")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.settingRowControl,
						"data-testid": "field-enabled",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: form.enabled,
							label: t("enabled"),
							disabled: !writable || saving,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									enabled: next
								});
							}
						})
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverviewBar, {
					status: form.enabled ? status : null,
					t
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
					id: "sources",
					title: t("groupSources"),
					summary: sourcesSummary,
					open: groups.sources,
					highlight: highlightGroup === "sources",
					onToggle: () => toggleGroup("sources"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.fieldLabel,
							children: t("sectionManual")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
							hint: t("manualHint"),
							values: form.manual,
							placeholder: t("manualPlaceholder"),
							testId: "field-manual",
							disabled: !writable || saving,
							t,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									manual: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.fieldLabel,
							children: t("sectionSubscription")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
							hint: t("subscriptionHint"),
							values: form.subscriptionUrls,
							placeholder: t("subscriptionPlaceholder"),
							testId: "field-subscriptions",
							redacted: true,
							disabled: !writable || saving,
							t,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									subscriptionUrls: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
							label: t("subscriptionRefreshMs"),
							hint: t("subscriptionRefreshMsHint"),
							value: form.refreshMs,
							testId: "field-refreshMs",
							type: "number",
							min: 6e4,
							step: 1,
							invalid: validation?.group === "sources" && validation.message === t("invalidRange"),
							disabled: !writable || saving,
							onChange: (value) => {
								setSaved(false);
								setForm({
									...form,
									refreshMs: value
								});
							},
							action: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								"data-testid": "refresh-subscriptions",
								disabled: actionBusy || !form.enabled,
								onClick: () => {
									bridgeAction({ scope: "subscription" });
								},
								children: t("subscriptionRefreshNow")
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
							label: t("subscriptionUserAgent"),
							hint: t("subscriptionUserAgentHint"),
							value: form.userAgent,
							testId: "field-subscriptionUserAgent",
							disabled: !writable || saving,
							onChange: (value) => {
								setSaved(false);
								setForm({
									...form,
									userAgent: value
								});
							}
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
							disabled: !writable || saving,
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
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
					id: "scheduling",
					title: t("groupScheduling"),
					summary: schedulingSummary,
					open: groups.scheduling,
					highlight: highlightGroup === "scheduling",
					onToggle: () => toggleGroup("scheduling"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
						label: t("pinnedAddress"),
						hint: t("pinnedAddressHint"),
						value: form.pinnedExitId,
						placeholder: t("manualPlaceholder"),
						testId: "field-pinnedExitId",
						disabled: !writable || saving,
						onChange: (value) => {
							setSaved(false);
							setForm({
								...form,
								pinnedExitId: value
							});
						},
						action: form.pinnedExitId === "" ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
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
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ip_pool_module_css_default.field,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.fieldLabel,
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
									disabled: !writable || saving,
									onChange: (next) => {
										setSaved(false);
										setForm({
											...form,
											pinnedStrict: next === "absolute"
										});
									}
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.fieldHint,
								children: form.pinnedStrict ? t("pinnedStrictOn") : t("pinnedStrictOff")
							})
						]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Group, {
					id: "probe",
					title: t("groupProbe"),
					summary: probeSummary,
					open: groups.probe,
					highlight: highlightGroup === "probe",
					onToggle: () => toggleGroup("probe"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
							value: form.probeModels,
							hint: t("probeModelsHint"),
							models: probeModelRows,
							loading: probeModelsLoading,
							disabled: !writable || saving,
							t,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									probeModels: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListEditor, {
							label: t("probeContents"),
							hint: t("probeContentsHint"),
							values: form.probeContents,
							placeholder: t("probeContentsPlaceholder"),
							testId: "field-probeContents",
							disabled: !writable || saving,
							t,
							onChange: (next) => {
								setSaved(false);
								setForm({
									...form,
									probeContents: next
								});
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ip_pool_module_css_default.fieldRow,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("probeConcurrency"),
								hint: t("probeConcurrencyHint"),
								value: form.maxConcurrentProbes,
								testId: "field-maxConcurrentProbes",
								type: "number",
								min: 1,
								max: 8,
								step: 1,
								invalid: validation?.group === "probe" && validation.message === t("invalidRange"),
								disabled: !writable || saving,
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										maxConcurrentProbes: value
									});
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextField, {
								label: t("poolSize"),
								hint: t("poolSizeHint"),
								value: form.poolSize,
								testId: "field-poolSize",
								type: "number",
								min: 1,
								max: 100,
								step: 1,
								invalid: validation?.group === "probe" && validation.message === t("invalidRange"),
								disabled: !writable || saving,
								onChange: (value) => {
									setSaved(false);
									setForm({
										...form,
										poolSize: value
									});
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							"data-testid": "probe-all",
							disabled: actionBusy || !form.enabled,
							onClick: () => {
								bridgeAction({ scope: "all" });
							},
							children: probing ? t("probeRunning").replace("{done}", String(probeDone)).replace("{total}", String(probeTotal)) : t("probeAll")
						}) })
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "usage",
					title: t("groupUsage"),
					summary: usageSummary,
					open: groups.usage,
					highlight: highlightGroup === "usage",
					onToggle: () => toggleGroup("usage"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "usage-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ip_pool_module_css_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"data-testid": "usage-scope",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
									id: "ip-pool-usage-scope",
									value: form.usageScope,
									options: [{
										value: "total",
										label: t("usageScopeTotal")
									}, {
										value: "run",
										label: t("usageScopeRun")
									}],
									label: t("usageScopeLabel"),
									disabled: actionBusy || !writable,
									onChange: (next) => {
										setUsageScope(next);
									}
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.fieldHint,
								children: t("usageScopeHint", { days: String(status?.usage?.retentionDays ?? 90) })
							})]
						}), status?.usage == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.status,
							children: t("usageNoStore")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ip_pool_module_css_default.statsSummary,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsChip,
									children: t("statsSummaryRequests", { count: status.usage.scoped.requests.toLocaleString() })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsChip,
									children: t("statsSummaryTokens", { count: usageTokens(status.usage.scoped) })
								}),
								(status.usage.recentSpeed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsChip,
									children: t("statsSummarySpeed", { count: (status.usage.recentSpeed ?? 0).toLocaleString() })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsChip,
									children: t("usageSummarySessions", { count: status.usage.sessions.length.toLocaleString() })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsChip,
									children: t("usageSummaryDays", { count: status.usage.days.length.toLocaleString() })
								})
							]
						})]
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "headers",
					title: t("groupHeaders"),
					summary: headersSummary,
					open: groups.headers,
					highlight: highlightGroup === "headers",
					onToggle: () => toggleGroup("headers"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RequestHeadersEditor, {
						text: headersText,
						effectiveUserAgent: status?.zenUserAgent,
						disabled: !writable || saving,
						t,
						onChange: (text) => {
							setSaved(false);
							setHeadersText(text);
						}
					})
				}),
				form.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
					id: "exits",
					title: t("groupExits"),
					summary: exitsSummary,
					open: groups.exits,
					highlight: highlightGroup === "exits",
					onToggle: () => toggleGroup("exits"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExitTable, {
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
						},
						onRotate: (id) => {
							rotateExit(id);
						}
					})
				}),
				validation !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					className: ip_pool_module_css_default.saveStatusError,
					children: validation.message
				}),
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
* The IP 池 page on the Plugins page.
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
/**
* A `plugins.bundle.config` entry bound to one settings controller: the DSH
* 0.2 bundle page embeds the configuration directly on the bundle's detail
* page (设置 → 插件 → oc2dsh lands straight on this form),
* but unlike the row/item slots its render site hands over NO `form` — the
* page draws the section and nothing else. The registration therefore closes
* over the settings provider's own controller for the served entry and
* subscribes here, which is the same snapshot/mutate pair the page would
* have bound (config-form.d.ts: getSnapshot is stable until the next
* acceptance, subscribe fires on replacements).
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
//#region src/client/region.ts
/**
* The stats modal's 地区 column (live request 2026-10-14): one short region
* code per exit row instead of the full "HK Central" the IP tooltip already
* carries.
*
* Input is the exit's `exitLocation`, which admission.ts builds as
* `${countryCode} ${city}` from the ip-api echo (`HK Central`, `SG Singapore`,
* `DE Frankfurt am Main`), so the first whitespace-separated token IS the
* ISO-3166-1 alpha-2 country code. The table below widens the codes the
* operator reads at a glance into the region labels they asked for — the two
* anchors are their own examples (香港 → HK, 新加坡 → SGP) — and anything
* unmapped falls back to the raw alpha-2 code rather than a blank, so a new
* airport location is still readable the day it appears.
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
//#region src/client/usage-format.ts
/**
* Shared token-display formatting for the IP-pool client surfaces (the footer
* entry, the exit-stats modal, the usage panel). These three helpers were
* duplicated verbatim across ExitStatsEntry.tsx and UsagePanel.tsx; they read
* the same bridge-shaped `TokenTotalsView` and must stay in lockstep so the
* footer, modal and panel never disagree about the same number.
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
	const days = usage.days.slice(-windowDays);
	const heaviest = days.reduce((max, row) => Math.max(max, row.tokens), 0);
	const scoped = usage.scoped;
	const speed = usage.recentSpeed ?? 0;
	const sessions = usage.sessions;
	const projects = usage.projects;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: ip_pool_module_css_default.usagePanel,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ip_pool_module_css_default.statsSummary,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `${ip_pool_module_css_default.statsChip} ${ip_pool_module_css_default.usageScopeChip}`,
						children: usage.scope === "run" ? t("usageScopeRun") : t("usageScopeTotal")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.statsChip,
						children: t("statsSummaryRequests", { count: scoped.requests.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.statsChip,
						children: t("statsSummaryTokens", { count: compact(grandTotal(scoped)) })
					}),
					speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.statsChip,
						children: t("statsSummarySpeed", { count: speed.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.statsChip,
						children: t("usageSummarySessions", { count: sessions.length.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.statsChip,
						children: t("usageSummaryDays", { count: usage.days.length.toLocaleString() })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: ip_pool_module_css_default.usageClear,
						children: confirming ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.usageClearPrompt,
								children: t("usageClearConfirm")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ip_pool_module_css_default.usageClearDanger,
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
				className: ip_pool_module_css_default.usageSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.usageSectionTitle,
					children: t("usageDailyTitle")
				}), days.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ip_pool_module_css_default.status,
					children: t("usageDailyEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: ip_pool_module_css_default.dayList,
					children: days.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: ip_pool_module_css_default.dayRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.dayLabel,
								children: shortDay(row.day)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.dayTrack,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.dayBar,
									style: { width: `${heaviest === 0 ? 0 : Math.max(2, Math.round(row.tokens / heaviest * 100))}%` }
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: ip_pool_module_css_default.dayValue,
								children: [compact(row.tokens), " tok"]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.dayRequests,
								children: t("usageRequestsShort", { count: row.requests.toLocaleString() })
							})
						]
					}, row.day))
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ip_pool_module_css_default.usageSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.usageSectionTitle,
					children: t("usageTopSessions")
				}), sessions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ip_pool_module_css_default.status,
					children: t("usageSessionsEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: ip_pool_module_css_default.usageTableWrap,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: ip_pool_module_css_default.usageTable,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColSession") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColProject") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColRequests") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("usageColTokens") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("statsColLastUsed") })
						] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: sessions.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.sessionLabel,
								title: row.id,
								children: row.label !== "" ? row.label : t("usageUnlabeled")
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.project === null ? t("statsNever") : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ip_pool_module_css_default.projectLabel,
								title: row.project.path,
								children: row.project.title
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.requests.toLocaleString() }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(row.tokens) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: timeLabel$1(row.lastAt, t("statsNever")) })
						] }, row.id)) })]
					})
				})]
			}),
			projects.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ip_pool_module_css_default.usageSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.usageSectionTitle,
					children: t("usageProjectsTitle")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: ip_pool_module_css_default.projectList,
					children: projects.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: ip_pool_module_css_default.projectRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.projectLabel,
							title: row.path,
							children: row.title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.projectMeta,
							children: t("usageProjectMeta", {
								sessions: row.sessions.toLocaleString(),
								tokens: compact(row.tokens),
								requests: row.requests.toLocaleString()
							})
						})]
					}, row.id))
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: ip_pool_module_css_default.usageFootnote,
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
//#region src/client/ExitStatsEntry.tsx
/**
* The display total: input + output + cacheRead + cacheWrite. The tracker's
* `totalTokens` is the net-new figure (input is normalized to exclude the
* cache buckets upstream), which read ~3x smaller than the Agent's own
* all-in count (live 2026-10-13) — the footer and the modal show the
* all-in number so the two agree; the breakdown stays in the table notes.
* (The number itself lives in usage-format.ts so the footer, modal and
* usage panel render the same figure.)
*/
/** Cache share of one bucket, for the per-row note (0 hides the note). */
function cacheTotal(tokens) {
	return tokens.cacheReadTokens + tokens.cacheWriteTokens;
}
/**
* The outcome toast's two clocks (live request 2026-10-14: the old note above
* the table never disappeared on its own). HOLD is full-opacity reading time;
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
/** An exit is "usable" exactly where the pool's pick() would consider it:
*  probed healthy and not cooling (bans are per-model, so they don't hide a
*  whole row). */
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
	const [status, setStatus] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const [failed, setFailed] = (0, react.useState)(false);
	/** Headline ordering contract: newest click wins, request count is home. */
	const [sort, setSort] = (0, react.useState)({
		key: "requests",
		dir: "desc"
	});
	/** Which pane the modal shows: the exit table, or the traffic breakdown. */
	const [tab, setTab] = (0, react.useState)("exits");
	/** The row action in flight (its key), so every button disables together. */
	const [busy, setBusy] = (0, react.useState)("");
	/**
	* The last action's outcome, shown as a toast DOCKED at the modal's
	* bottom-right corner (live request 2026-10-14). It used to be a note
	* above the table that stayed until the next action — the green
	* "操作成功" line never went away on its own. `seq` restarts the show
	* cycle when the same text fires twice in a row.
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
	/**
	* One row action (固定 / 取消固定 / 轮换) over the bridge. The bridge owns the
	* settings write, the live pin and the candidate refill, so this stays a
	* POST plus a re-read — and it reports what actually happened, because
	* "deleted" means two different things (a reserve took the slot, or the row
	* sank to the tail).
	*/
	/**
	* Clear the usage ledger (live request 2026-10-14: 清空功能按钮). Same
	* loopback route family as the row actions; the modal re-reads /status
	* afterwards so the chips, the bar list and the footer all drop to zero
	* together.
	*/
	const clearUsage = (0, react.useCallback)(async () => {
		setNote(null);
		try {
			const body = await (await fetch(`${BRIDGE_PREFIX}/usage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "reset" })
			})).json();
			if (!body.ok || body.value?.cleared !== true) {
				showNote(t("statsActionFailed"), true);
				return false;
			}
			showNote(t("usageCleared"), false);
			await refresh();
			return true;
		} catch {
			showNote(t("statsActionFailed"), true);
			return false;
		}
	}, [
		refresh,
		showNote,
		t
	]);
	const runExitAction = (0, react.useCallback)(async (action, exitId) => {
		setBusy(`${action}:${exitId ?? ""}`);
		setNote(null);
		try {
			const body = await (await fetch(`${BRIDGE_PREFIX}/exit`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(action === "pin-local" || action === "unpin" ? { action } : {
					action,
					exitId
				})
			})).json();
			if (!body.ok || body.value === void 0) {
				showNote(t("statsActionFailed"), true);
				return;
			}
			const value = body.value;
			if (action === "rotate" && value.busy === true) {
				showNote(t("statsActionBusy"), true);
				return;
			}
			const text = action === "rotate" ? value.promoted === true ? t("statsActionReplaced") : t("statsActionDemoted") : action === "unpin" ? t("statsActionUnpinned") : action === "pin-local" ? t("statsActionPinnedLocal") : t("statsActionPinned");
			showNote(value.persisted === false ? `${text} · ${t("statsActionVolatile")}` : text, value.persisted === false);
		} catch {
			showNote(t("statsActionFailed"), true);
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
	* The footer's own numbers (live request 2026-10-14: 左下角显示总览). The
	* ledger's ALL-TIME totals, never the scope the card's switch selected: the
	* footer is the glanceable "what have I spent" figure, and it has to mean the
	* same thing regardless of what the modal was last left on. Falls back to the
	* live totals when the host serves no ledger.
	*/
	const overview = (0, react.useMemo)(() => {
		const ledger = status?.usage;
		if (ledger === null || ledger === void 0) return totals;
		const all = ledger.total;
		const allIn = grandTotal(all);
		return {
			requests: all.requests,
			tokens: allIn,
			inFlight: totals.inFlight,
			speed: status?.recentSpeed ?? 0
		};
	}, [status, totals]);
	const usable = status?.availableTotal ?? 0;
	const total = status?.total ?? 0;
	/**
	* The pool being switched off means no traffic goes through an exit at all,
	* so the exit table is not a view of anything in use — rendering it anyway
	* is how "0/13 available" read as a broken pool instead of "you turned it
	* off" (live 2026-10-13). Off lists the local row alone, exactly what the
	* operator asked for.
	*/
	const poolOff = status !== null && status.enabled === false;
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
			className: ip_pool_module_css_default.statsSortButton,
			onClick: () => setSort((current) => ({
				key,
				dir: current.key === key && current.dir === "desc" ? "asc" : "desc"
			})),
			children: [label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.statsSortArrow,
				"aria-hidden": "true",
				children: sort.key === key ? sort.dir === "asc" ? "▲" : "▼" : ""
			})]
		})
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: wide ? ip_pool_module_css_default.footerEntry : `${ip_pool_module_css_default.footerEntry} ${ip_pool_module_css_default.footerEntryCompact}`,
		onClick: () => setOpen(true),
		title: t("footerTitle"),
		"aria-haspopup": "dialog",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.footerIcon,
				"aria-hidden": "true",
				children: "◈"
			}),
			wide && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: ip_pool_module_css_default.footerText,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.footerMain,
					children: status === null ? t("footerDisabled") : poolOff ? t("footerLocal") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [usable, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
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
						t("footerRequests", { count: overview.requests.toLocaleString() }),
						" · ",
						compact(overview.tokens),
						" tok",
						overview.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", t("footerSpeed", { count: overview.speed.toLocaleString() })] })
					]
				})]
			}),
			wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: ip_pool_module_css_default.footerCompactOnNarrow,
				title: `${t("footerRequests", { count: overview.requests.toLocaleString() })} · ${compact(status?.todayTokens ?? 0)} tok${overview.speed > 0 ? ` · ${t("footerSpeed", { count: overview.speed.toLocaleString() })}` : ""}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.footerCompactLine,
					children: status === null ? "—" : `${compact(status.todayTokens ?? 0)} tok`
				}), status !== null && overview.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ip_pool_module_css_default.footerCompactLine,
					children: t("footerSpeed", { count: overview.speed.toLocaleString() })
				})]
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ip_pool_module_css_default.footerCompact,
				title: `${t("footerRequests", { count: overview.requests.toLocaleString() })} · ${compact(overview.tokens)} tok${overview.speed > 0 ? ` · ${t("footerSpeed", { count: overview.speed.toLocaleString() })}` : ""}`,
				children: status === null ? "—" : `${compact(overview.tokens)} tok`
			})
		]
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(__deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose: () => setOpen(false),
		title: t("statsTitle"),
		closeLabel: t("statsClose"),
		description: t("statsDescription"),
		className: ip_pool_module_css_default.statsModal,
		contentClassName: ip_pool_module_css_default.statsContent,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ip_pool_module_css_default.tabBar,
				role: "tablist",
				"aria-label": t("statsTitle"),
				children: ["exits", "usage"].map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "tab",
					"aria-selected": tab === key,
					className: tab === key ? `${ip_pool_module_css_default.tab} ${ip_pool_module_css_default.tabActive}` : ip_pool_module_css_default.tab,
					onClick: () => setTab(key),
					children: key === "exits" ? t("tabExits") : t("tabUsage")
				}, key))
			}),
			tab === "usage" ? status?.usage == null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: ip_pool_module_css_default.status,
				children: t("usageNoStore")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsagePanel, {
				usage: status.usage,
				t,
				onClear: clearUsage
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: ip_pool_module_css_default.statsSummary,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.statsChip,
							children: poolOff ? t("footerDisabled") : t("footerUsable", {
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
						totals.speed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ip_pool_module_css_default.statsChip,
							children: t("statsSummarySpeed", { count: totals.speed.toLocaleString() })
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
				}),
				poolOff && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ip_pool_module_css_default.status,
					children: t("statsPoolOff")
				}),
				!poolOff && rows.length === 0 && (status?.local?.requests ?? 0) === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ip_pool_module_css_default.status,
					children: failed && status === null ? t("statsError") : t("statsEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: ip_pool_module_css_default.statsWrap,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: ip_pool_module_css_default.statsTable,
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
							const dotClass = usableRow ? ip_pool_module_css_default.statsDotOk : exit.state === "dead" ? ip_pool_module_css_default.statsDotBad : ip_pool_module_css_default.statsDotWarn;
							const stateLabel = exit.demoted === true ? t("stateDemoted") : usableRow ? t("statsStateUsable") : exit.cooling ? t("stateCooling") : exit.state === "dead" ? t("stateDead") : t("statsStateUnverified");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
								className: usableRow ? void 0 : ip_pool_module_css_default.statsRowMuted,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										className: ip_pool_module_css_default.mono,
										title: exit.exitLocation || void 0,
										children: [
											exit.exitIP !== "" ? exit.exitIP : t("statsNever"),
											exit.pinned ? ` · ${t("exitPinnedMark")}` : "",
											exit.exitIP === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: ip_pool_module_css_default.statsEndpoint,
												children: exit.id
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: ip_pool_module_css_default.statsRegion,
										title: exit.exitLocation || void 0,
										children: regionCode(exit.exitLocation) || t("statsNever")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${ip_pool_module_css_default.statsDot} ${dotClass}`,
										"aria-hidden": "true"
									}), stateLabel] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.requests.toLocaleString() }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: compact(exit.tokens.inputTokens) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [compact(exit.tokens.outputTokens), (exit.speed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: ip_pool_module_css_default.statsEndpoint,
										children: t("statsSpeedNote", { count: (exit.speed ?? 0).toLocaleString() })
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: cacheTotal(exit.tokens) > 0 ? compact(cacheTotal(exit.tokens)) : "—" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: exit.latencyMs > 0 ? `${exit.latencyMs}ms` : t("statsNever") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [exit.inFlight > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: ip_pool_module_css_default.statsInflight,
										children: t("statsInflight", { count: exit.inFlight })
									}), timeLabel(exit.lastUsedAt, t("statsNever"))] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: ip_pool_module_css_default.statsActions,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: ip_pool_module_css_default.actionGroup,
											children: [exit.pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: `${ip_pool_module_css_default.rowAction} ${ip_pool_module_css_default.rowActionActive}`,
												disabled: busy !== "",
												title: t("statsUnpinHint"),
												"aria-label": t("statsUnpin"),
												onClick: () => {
													runExitAction("unpin");
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnpinIcon, {})
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: ip_pool_module_css_default.rowAction,
												disabled: busy !== "",
												title: t("statsPinHint"),
												"aria-label": t("statsPin"),
												onClick: () => {
													runExitAction("pin", exit.id);
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PinIcon, {})
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: ip_pool_module_css_default.rowAction,
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
							className: ip_pool_module_css_default.statsRowLocal,
							"data-local-egress": true,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: ip_pool_module_css_default.mono,
									children: t("statsLocalIp")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsNever") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: `${ip_pool_module_css_default.statsDot} ${ip_pool_module_css_default.statsDotOk}`,
									"aria-hidden": "true"
								}), t("statsLocalState")] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: (status?.local?.requests ?? 0).toLocaleString() }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: status?.local === void 0 ? t("statsNever") : compact(status.local.tokens.inputTokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: status?.local === void 0 ? t("statsNever") : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [compact(status.local.tokens.outputTokens), (status.local.speed ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: ip_pool_module_css_default.statsEndpoint,
									children: t("statsSpeedNote", { count: (status.local.speed ?? 0).toLocaleString() })
								})] }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: status?.local === void 0 || cacheTotal(status.local.tokens) === 0 ? "—" : compact(cacheTotal(status.local.tokens)) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: t("statsNever") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: timeLabel(status?.local?.lastUsedAt ?? 0, t("statsNever")) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: ip_pool_module_css_default.statsActions,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: ip_pool_module_css_default.actionGroup,
										children: status?.pinned?.local === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: `${ip_pool_module_css_default.rowAction} ${ip_pool_module_css_default.rowActionActive}`,
											disabled: busy !== "",
											title: t("statsUnpinHint"),
											"aria-label": t("statsUnpin"),
											onClick: () => {
												runExitAction("unpin");
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnpinIcon, {})
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: ip_pool_module_css_default.rowAction,
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
			] }),
			note !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: note.warn ? `${ip_pool_module_css_default.statsToast} ${ip_pool_module_css_default.statsToastWarn}` : ip_pool_module_css_default.statsToast,
				style: { "--stats-toast-hold": `${TOAST_HOLD_MS}ms` },
				role: "status",
				children: note.text
			}, note.seq)
		]
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
	requestHeadersLabel: "自定义请求头（requestHeaders）",
	requestHeadersHint: "每行一个 Header-Name: value，例如 User-Agent 或 x-opencode-client。保存后对下一次正式对话、模型列表和准入探测生效，与 IP 池开关无关；留空恢复 profile 中的 userAgent 或插件默认值。鉴权、Cookie 和传输头由插件管理。",
	requestHeadersEffectiveUA: "当前生效的 Zen User-Agent：",
	requestHeadersConflict: "请求头已在其他页面更新。请先丢弃本页修改以加载最新值，再重新编辑。",
	requestHeadersInvalid: "请求头格式无效。请每行填写 Header-Name: 非空值，勿重复名称或填写鉴权、Cookie、传输头；最多 32 个，总长不超过 8192 字节。",
	title: "IP 池（oc2dsh）",
	description: "多出口调度免费模型的可用性：出口间自动轮换、429 冷却、按出口×模型探活。",
	statusLoading: "加载中…",
	statusUnavailable: "设置服务不可用，无法读写 IP 池配置。",
	enabled: "启用 IP 池（enabled）",
	enabledHint: "关闭后全部流量直连，行为与本插件未装 IP 池时完全一致。",
	poolStateHealthy: "健康",
	poolStateWarning: "偏低",
	poolStateCritical: "告急",
	poolStateEmergency: "枯竭",
	poolAvailable: "池可用 {available}/{total}（容量 {poolSize}）",
	poolSources: "出口来源：手填 {manual} · 订阅 {subscription}",
	pinnedBadge: "固定主力",
	pinnedBadgeLocal: "固定本机（直连）",
	deferredNotice: "路由已退避：{reason}",
	sectionManual: "手填代理（manual）",
	manualHint: "一行一个：http://host:port 或 socks5://host:port。适合自备节点/专线。",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "订阅（subscription）",
	subscriptionHint: "机场/自建 Clash·V2ray 订阅 URL，一行一个；明文节点直拨，加密节点经 sing-box 转换。",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "刷新间隔（毫秒）",
	subscriptionRefreshMsHint: "默认 1,800,000（30 分钟）。订阅只低频拉取，绝不并发轰炸。",
	subscriptionRefreshNow: "立即刷新",
	subscriptionUserAgent: "拉取 UA（subscription.userAgent）",
	subscriptionUserAgentHint: "拉订阅时发送的 User-Agent。机场常按它做白名单（不在名单里会返回错误页或 502），有的还按它决定返回哪种格式：Clash 形状给 YAML，v2ray 形状给 base64 链接。留空 = 内置默认值。",
	singboxPath: "sing-box 路径（singbox.path）",
	singboxPathHint: "加密节点的转换核心：PATH 名或绝对路径。未装则加密节点停在「待转换」。",
	pinnedAddress: "主力出口地址",
	pinnedAddressHint: "例如 Clash 混合端口 http://127.0.0.1:7897，或专线 http://host:port。即填即固定；填 local = 固定本机（直连，不走任何出口）。",
	pinnedStrict: "绝对固定（pinnedStrict）",
	pinnedStrictOn: "绝对固定：失败也不换、不直连",
	pinnedStrictOff: "主力+备胎：429/断线自动切换，恢复后回归",
	pinnedUnset: "解除固定",
	probeModels: "探活模型（probeModels）",
	probeModelsHint: "从列表选择探活模型；不选 = 默认 big-pickle。同一出口内多模型串行探测。",
	probeModelPick: "选择模型…",
	probeModelUnverified: "未验证",
	probeModelsDefault: "当前使用默认探活模型：big-pickle（S3 已验证清单首个）。",
	probeContents: "探测文案（probeContents）",
	probeContentsHint: "冒烟探测发给上游的那句话：每个出口每次探测随机挑一条（同一出口本轮多模型共用）；留空 = 默认 hello。",
	probeContentsPlaceholder: "例如：hello",
	poolSize: "池子容量（poolSize）",
	poolSizeHint: "同时在线的出口数（1-100，默认 20）：上线时先测速，取最快的前 N 个，并把 sing-box 本地监听收缩到它们（池子之外的节点留作候补）。",
	probeConcurrency: "并发上限（maxConcurrentProbes）",
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
	stateOk: "ok",
	stateCooling: "冷却中",
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
	copyCompliance: "匿名配额受上游限流；多出口不绕过配额，只在出口间调度。固定/订阅节点优先；公共免费代理有安全与合规风险。",
	footerLabel: "出口",
	footerTitle: "IP 池出口统计",
	footerUsable: "可用 {usable}/{total}",
	footerRequests: "{count} 请求",
	footerSpeed: "{count} tok/s",
	footerDisabled: "IP 池未启用",
	footerLocal: "本地直连",
	statsTitle: "数据统计",
	statsDescription: "进程内累计（重启清零），总数 = 输入 + 输出 + 缓存读写；点击表头排序，默认按请求数降序。",
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
	usageScopeHint: "总览 = 持久记录，重启不丢，按天保留 {days} 天；本次重启 = 当前进程。左下角入口固定显示总览；出口列表里的用量数字随这里切换。",
	usageSummarySessions: "会话 {count}",
	usageSummaryDays: "活跃 {count} 天",
	usageRequestsShort: "{count} 次",
	usageDailyTitle: "每天",
	usageDailyEmpty: "还没有按天记录。",
	usageTopSessions: "Top 会话",
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
	statsInflight: "在途×{count}",
	statsNever: "—",
	statsEmpty: "暂无出口数据：IP 池未启用或尚未准入出口。",
	statsPoolOff: "IP 池已关闭：没有流量经过出口，下面只统计本机（直连）流量。",
	statsError: "统计获取失败",
	save: "保存",
	saving: "保存中…",
	saved: "已保存，立即生效",
	saveError: "保存失败",
	readOnly: "当前配置为只读，无法保存修改。",
	invalidRange: "数值超出允许范围。",
	invalidProxy: "代理地址格式应为 http://host:port 或 socks5://host:port。",
	invalidUrl: "请填写合法的 http(s) URL。",
	invalidModel: "模型 id 不能为空。",
	refreshError: "状态获取失败",
	groupSources: "出口来源",
	groupScheduling: "调度行为",
	groupProbe: "探活",
	groupUsage: "用量",
	groupHeaders: "Zen 请求头",
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
	pinnedModeFallback: "主力+备胎",
	pinnedModeAbsolute: "绝对固定",
	listAdd: "添加",
	listExists: "该项已存在",
	listRemove: "移除"
};
/** English dictionary, checked complete against the zh key set. */
const en = {
	requestHeadersLabel: "Custom request headers (requestHeaders)",
	requestHeadersHint: "One Header-Name: value per line, e.g. User-Agent or x-opencode-client. Applies to the next chat, model-list refresh and admission probe, regardless of the IP pool switch. Leave blank to use the profile userAgent or built-in default. Authentication, cookies and transport headers are managed by the plugin.",
	requestHeadersEffectiveUA: "Effective Zen User-Agent:",
	requestHeadersConflict: "Request headers changed elsewhere. Discard this draft to load the latest values, then edit again.",
	requestHeadersInvalid: "Invalid headers. Use one Header-Name: non-empty value per line, without duplicate names, authentication, cookies or transport headers. Maximum 32 headers and 8192 bytes in total.",
	title: "IP Pool (oc2dsh)",
	description: "Schedules free-model availability across exit IPs: rotation, 429 cooldown, per-exit×model probes.",
	statusLoading: "Loading…",
	statusUnavailable: "Settings service unavailable; the IP pool configuration cannot be read or written.",
	enabled: "Enable IP pool (enabled)",
	enabledHint: "Off = every request goes direct, exactly as if the pool were not installed.",
	poolStateHealthy: "healthy",
	poolStateWarning: "low",
	poolStateCritical: "critical",
	poolStateEmergency: "depleted",
	poolAvailable: "{available}/{total} usable (capacity {poolSize})",
	poolSources: "Sources: manual {manual} · subscription {subscription}",
	pinnedBadge: "pinned",
	pinnedBadgeLocal: "pinned to this machine (direct)",
	deferredNotice: "Routing deferred: {reason}",
	sectionManual: "Manual proxies (manual)",
	manualHint: "One per line: http://host:port or socks5://host:port. For your own nodes.",
	manualPlaceholder: "http://127.0.0.1:7897",
	sectionSubscription: "Subscriptions (subscription)",
	subscriptionHint: "Airport/self-hosted Clash·V2ray subscription URLs, one per line; plaintext nodes dial directly, encrypted ones convert via sing-box.",
	subscriptionPlaceholder: "https://…",
	subscriptionRefreshMs: "Refresh interval (ms)",
	subscriptionRefreshMsHint: "Default 1,800,000 (30 min). Subscriptions are pulled gently, never fanned out.",
	subscriptionRefreshNow: "Refresh now",
	subscriptionUserAgent: "Fetch UA (subscription.userAgent)",
	subscriptionUserAgentHint: "User-Agent sent when pulling subscriptions. Airports commonly allow-list it (an unlisted one returns an error page or a 502), and some pick the returned format from it: a Clash-shaped UA yields YAML, a v2ray-shaped one yields base64 links. Empty = the built-in default.",
	singboxPath: "sing-box path (singbox.path)",
	singboxPathHint: "Conversion core for encrypted nodes: PATH name or absolute path. Without it they stay \"pending conversion\".",
	pinnedAddress: "Primary exit address",
	pinnedAddressHint: "e.g. a Clash mixed port http://127.0.0.1:7897, or a leased line. Pins on save; `local` pins this machine (direct, no exit).",
	pinnedStrict: "Absolute pinning (pinnedStrict)",
	pinnedStrictOn: "Absolute: never rotate, never direct",
	pinnedStrictOff: "Primary + fallback: rotate on 429/drop, return when recovered",
	pinnedUnset: "Unpin",
	probeModels: "Probe models (probeModels)",
	probeModelsHint: "Pick probe models from the list; none selected = default big-pickle. Multiple models stay serial per exit.",
	probeModelPick: "Pick a model…",
	probeModelUnverified: "unverified",
	probeModelsDefault: "Using the default probe model: big-pickle (first of the S3 verified list).",
	probeContents: "Probe contents (probeContents)",
	probeContentsHint: "The sentence the smoke request sends upstream: one entry is drawn per exit probe (shared by that exit's models); empty = default hello.",
	probeContentsPlaceholder: "e.g. hello",
	poolSize: "Pool size (poolSize)",
	poolSizeHint: "Exits kept online at once (1-100, default 20): the onboarding speed-tests candidates, keeps the fastest N and shrinks the sing-box listeners to them; the rest stay as reserve.",
	probeConcurrency: "Concurrency cap (maxConcurrentProbes)",
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
	stateOk: "ok",
	stateCooling: "cooling",
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
	copyCompliance: "Anonymous quota is upstream-rate-limited; multiple exits do not bypass quota, they schedule across it. Pinned/subscription nodes first; public free proxies carry security and compliance risk.",
	footerLabel: "exits",
	footerTitle: "IP pool exit stats",
	footerUsable: "{usable}/{total} usable",
	footerRequests: "{count} requests",
	footerSpeed: "{count} tok/s",
	footerDisabled: "IP pool off",
	footerLocal: "Local direct",
	statsTitle: "Data stats",
	statsDescription: "Process-lifetime totals (reset on restart; the total includes cache read/write); click a header to sort, request count desc by default.",
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
	usageScopeHint: "Overview = the persisted ledger, kept {days} days and surviving restarts; This run = the current process. The footer entry always shows the overview; the exit list's usage numbers follow this switch.",
	usageSummarySessions: "{count} sessions",
	usageSummaryDays: "{count} active days",
	usageRequestsShort: "{count} req",
	usageDailyTitle: "Per day",
	usageDailyEmpty: "Nothing recorded per day yet.",
	usageTopSessions: "Top sessions",
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
	statsInflight: "{count} in flight",
	statsNever: "—",
	statsEmpty: "No exit data yet: the pool is off or has admitted no exits.",
	statsPoolOff: "IP pool is off: no traffic goes through an exit, so only local (direct) egress is counted below.",
	statsError: "Stats fetch failed",
	save: "Save",
	saving: "Saving…",
	saved: "Saved, applied live",
	saveError: "Save failed",
	readOnly: "This configuration is read-only; changes cannot be saved.",
	invalidRange: "A value is out of range.",
	invalidProxy: "Expected http://host:port or socks5://host:port.",
	invalidUrl: "Enter a valid http(s) URL.",
	invalidModel: "Model id must not be empty.",
	refreshError: "Status fetch failed",
	groupSources: "Exit sources",
	groupScheduling: "Scheduling",
	groupProbe: "Probing",
	groupUsage: "Usage",
	groupHeaders: "Zen request headers",
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
				const disposers = ["dsh-opencode-free-provider", "oc2dsh"].map((pkg) => slots.register({
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