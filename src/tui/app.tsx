// raprid tui の画面 (Ink / React)。データ取得は stores、キー操作は model に任せ、ここは描画と配線だけを行う。

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  detailLines,
  type Effect,
  handleKey,
  layoutFor,
  minColumns,
  minRows,
  type Panel,
  panelsFor,
  reconcile,
  type Row,
  rowsFor,
  selectedIndex,
  type Tab,
  type UiState,
  unresolvedCount,
  initialState,
} from "./model.js";
import type { DetailStore, SnapshotState, SnapshotStore } from "./stores.js";
import { type Line, padEnd, sanitize, truncate, width, wrapLines } from "./text.js";
import { statusOrder } from "./types.js";

export interface AppProps {
  snapshots: SnapshotStore;
  details: DetailStore;
  initialJob: string | null;
  projectName: string;
  columns?: number; // 試験用に端末の大きさを固定する
  rows?: number;
  onUnmount?: () => void; // 画面が閉じるとき (シグナルによる終了を含む) に子プロセスを止める
}

const tabLabels: Record<Tab, string> = { task: "task", qa: "QA", issues: "要確認" };
const jobsWidth = 22;

function time(date: Date | undefined): string {
  if (!date) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

function fetchStatus(state: SnapshotState): { text: string; color?: string } {
  if (state.error) {
    const stopped = state.stopped ? "。自動取得を止めました (r で再試行)" : "";
    return { text: `更新失敗 ${time(state.error.at)}: ${sanitize(state.error.message)}${stopped}`, color: "red" };
  }
  if (!state.snapshot) return { text: "読み込み中…" };
  return { text: `更新 ${time(state.fetchedAt)}${state.loading ? " …" : ""}` };
}

function rowText(row: Row, idWidth: number, statusWidth: number): string {
  if (row.issue) {
    const issue = row.issue;
    return `${issue.severity === "error" ? "E" : "W"} ${sanitize(issue.id ?? issue.path)}  ${sanitize(issue.message)}`;
  }
  const record = row.record!;
  const id = padEnd(record.id === null ? "ID未設定" : sanitize(record.id), idWidth);
  const status = padEnd(record.status === null ? "未設定" : sanitize(record.status), statusWidth);
  const title = sanitize(record.title ?? record.name);
  if (record.kind === "task") {
    const waiting = record.status === "pending" ? `  待ち: ${record.blockedBy.length > 0 ? record.blockedBy.map((value) => sanitize(value)).join(", ") : "(未記入)"}` : "";
    return `${id} ${status} ${title}${waiting}`;
  }
  return `${id} ${status} ${sanitize(record.askTo ?? "未設定")}  ${title}`;
}

function PanelBox(props: { title: string; focused: boolean; width: number; height: number; children?: ReactNode }) {
  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle={props.focused ? "double" : "single"} borderColor={props.focused ? "cyan" : undefined}>
      <Text bold={props.focused} wrap="truncate-end">
        {props.focused ? "▶ " : "  "}
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

function ListRows(props: { rows: Row[]; index: number; width: number; height: number }) {
  const { rows, index, height } = props;
  if (rows.length === 0) return <Text dimColor>該当する項目がありません</Text>;
  const start = Math.min(Math.max(0, index - Math.floor(height / 2)), Math.max(0, rows.length - height));
  const shown = rows.slice(start, start + height);
  const records = shown.filter((row) => row.record).map((row) => row.record!);
  const idWidth = Math.max(0, ...records.map((record) => width(record.id ?? "ID未設定")));
  const statusWidth = Math.max(0, ...records.map((record) => width(record.status ?? "未設定")));
  return (
    <>
      {shown.map((row, offset) => {
        const selected = start + offset === index;
        return (
          <Text key={row.key} inverse={selected} wrap="truncate-end">
            {truncate(`${selected ? ">" : " "} ${rowText(row, idWidth, statusWidth)}`, props.width)}
          </Text>
        );
      })}
    </>
  );
}

function JobRows(props: { snapshot: SnapshotState["snapshot"]; job: string | null; width: number; height: number }) {
  const options = [{ name: null as string | null, count: props.snapshot?.tasks.length ?? 0 }, ...(props.snapshot?.jobs ?? []).map((job) => ({ name: job.name as string | null, count: job.counts.task.total }))];
  const index = Math.max(0, options.findIndex((option) => option.name === props.job));
  const start = Math.min(Math.max(0, index - Math.floor(props.height / 2)), Math.max(0, options.length - props.height));
  return (
    <>
      {options.slice(start, start + props.height).map((option, offset) => {
        const selected = start + offset === index;
        const label = `${selected ? ">" : " "} ${sanitize(option.name ?? "全案件")}`;
        const count = String(option.count);
        return (
          <Text key={option.name ?? "\u0000all"} inverse={selected} wrap="truncate-end">
            {padEnd(truncate(label, Math.max(1, props.width - count.length - 1)), props.width - count.length)}
            {count}
          </Text>
        );
      })}
    </>
  );
}

function DetailView(props: { lines: Line[]; scroll: number; height: number; width: number }) {
  const shown = props.lines.slice(props.scroll, props.scroll + props.height);
  return (
    <>
      {shown.map((line, offset) => (
        <Text key={offset} bold={line.bold} dimColor={line.dim} color={line.color} wrap="truncate-end">
          {line.text === "" ? " " : truncate(line.text, props.width)}
        </Text>
      ))}
    </>
  );
}

function Dialog(props: { title: string; width: number; height: number; lines: { text: string; selected?: boolean; dim?: boolean }[] }) {
  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="double" borderColor="cyan">
      <Text bold>{props.title}</Text>
      {props.lines.slice(0, Math.max(0, props.height - 3)).map((line, index) => (
        <Text key={index} inverse={line.selected} dimColor={line.dim} wrap="truncate-end">
          {truncate(line.text, props.width - 2)}
        </Text>
      ))}
    </Box>
  );
}

const helpLines = [
  "↑↓            一覧の選択・詳細のスクロール",
  "Tab / S-Tab   パネルの移動",
  "1 / 2 / 3     task / QA / 要確認",
  "Enter         詳細へ (狭い端末では全面表示)",
  "Esc           取消・前の画面",
  "/             ID・名前・タイトル・質問を検索",
  "g             案件の選択 (全案件も選べる)",
  "f             状態の絞り込み (Space で切替)",
  "v             完了済みも含む全件表示の切替",
  "r             再取得",
  "PgUp / PgDn   詳細のページ送り",
  "?             このヘルプ",
  "q / Ctrl+C    終了",
];

function keyHints(state: UiState, panels: Panel[]): string {
  switch (state.mode.kind) {
    case "search":
      return "文字を入力して検索  Enter 確定  Esc 取消";
    case "jobPicker":
      return "↑↓ 選択  Enter 決定  Esc 取消";
    case "filter":
      return "↑↓ 移動  Space 切替  Enter 適用 (空なら既定)  Esc 取消";
    case "help":
      return "Esc / ? で閉じる";
    default:
      if (state.narrowDetail) return "↑↓ PgUp/PgDn スクロール  Esc 一覧へ  q 終了";
      return `↑↓ 移動  ${panels.length > 1 ? "Tab パネル  " : ""}1-3 種類  Enter 詳細  / 検索  g 案件  f 状態  v 全件  r 更新  ? ヘルプ  q 終了`;
  }
}

function filterSummary(state: UiState): string {
  const parts: string[] = [];
  if (state.tab !== "issues") {
    const filter = state.filters[state.tab];
    parts.push(filter ? `状態: ${filter.join(",")}` : state.showAll ? "全件" : "未完了のみ");
  }
  if (state.search) parts.push(`検索: ${sanitize(state.search)}`);
  return parts.join("  ");
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = props.columns ?? size.columns;
  const rows = props.rows ?? size.rows;
  const snap = useSyncExternalStore(props.snapshots.subscribe, props.snapshots.getState);
  const detail = useSyncExternalStore(props.details.subscribe, props.details.getState);
  const [state, setState] = useState(() => initialState(props.initialJob));
  const stateRef = useRef(state);
  stateRef.current = state;

  const layout = layoutFor(columns, rows);
  const panels = panelsFor(layout, state);
  const snapshot = snap.snapshot;
  const jobs = useMemo(() => (snapshot?.jobs ?? []).map((job) => job.name), [snapshot]);
  const filterKey = `${state.job}\u0000${state.search}\u0000${state.showAll}\u0000${state.filters.task}\u0000${state.filters.qa}`;
  const rowsByTab = useMemo(() => {
    const base = { job: state.job, search: state.search, showAll: state.showAll, filters: state.filters };
    return { task: rowsFor(snapshot, { ...base, tab: "task" }), qa: rowsFor(snapshot, { ...base, tab: "qa" }), issues: rowsFor(snapshot, { ...base, tab: "issues" }) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, filterKey]);
  const list = rowsByTab[state.tab];
  const index = selectedIndex(state, list);
  const selected = index >= 0 ? list[index] : undefined;

  // 選択していた項目が消えたら近くへ移す
  useEffect(() => {
    const next = reconcile(stateRef.current, list, snapshot);
    if (next !== stateRef.current) setState(next);
  }, [list, snapshot]);

  // 詳細の取得対象 (要確認の行は snapshot だけで表示する)
  const record = selected?.record;
  useEffect(() => {
    props.details.select(record ? { kind: record.kind, job: record.job, name: record.name, path: record.path, revision: record.revision } : undefined);
  }, [props.details, record?.path, record?.revision, record?.kind, record?.job, record?.name]);

  useEffect(() => () => props.onUnmount?.(), [props.onUnmount]);

  // 大きさ: 上 1 行 (状態)、下 2 行 (表示条件・キー案内)
  const bodyHeight = Math.max(0, rows - 3);
  const innerHeight = Math.max(0, bodyHeight - 3); // 枠 2 行 + パネル名 1 行
  let listWidth = columns;
  let detailWidth = 0;
  if (layout === "wide") {
    listWidth = Math.floor((columns - jobsWidth) * 0.4);
    detailWidth = columns - jobsWidth - listWidth;
  } else if (layout === "medium") {
    listWidth = Math.floor(columns * 0.45);
    detailWidth = columns - listWidth;
  } else if (layout === "narrow") {
    detailWidth = columns;
  }
  const detailInner = Math.max(10, detailWidth - 2);
  const lines = useMemo(() => wrapLines(detailLines(selected, detail, snapshot), detailInner), [selected, detail, snapshot, detailInner]);
  const scroll = Math.min(state.detailScroll, Math.max(0, lines.length - innerHeight));

  const run = (effects: Effect[]) => {
    for (const effect of effects) {
      if (effect === "exit") exit();
      if (effect === "refresh") {
        props.snapshots.refresh();
        if (props.details.getState().error) props.details.reload();
      }
    }
  };

  useInput((input, key) => {
    const result = handleKey(stateRef.current, input, key, { rows: list, jobs, layout, detailHeight: innerHeight, detailLength: lines.length });
    stateRef.current = result.state;
    setState(result.state);
    run(result.effects);
  });

  // 貼り付けは検索欄にだけ入れる (改行は空白にする)
  usePaste((text) => {
    const current = stateRef.current;
    if (current.mode.kind !== "search") return;
    const draft = current.mode.draft + sanitize(text);
    const next: UiState = { ...current, search: draft, mode: { ...current.mode, draft }, selection: { ...current.selection, [current.tab]: { key: null, index: 0 } } };
    stateRef.current = next;
    setState(next);
  });

  if (layout === "tooSmall") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Text wrap="wrap">
          端末が小さすぎます ({columns}x{rows})。{minColumns}x{minRows} 以上に広げてください。q で終了します。
        </Text>
      </Box>
    );
  }

  const status = fetchStatus(snap);
  const unresolved = unresolvedCount(snapshot, state.job);
  const header = `raprid tui  ${sanitize(props.projectName)}  案件: ${sanitize(state.job ?? "全案件")}  未解決QA ${unresolved}  `;
  const tabs = (["task", "qa", "issues"] as Tab[])
    .map((tab, number) => (tab === state.tab ? `[${number + 1} ${tabLabels[tab]} ${rowsByTab[tab].length}]` : ` ${number + 1} ${tabLabels[tab]} ${rowsByTab[tab].length} `))
    .join(" ");
  const focus = panels.includes(state.focus) ? state.focus : panels[0];
  const notice = state.mode.kind === "search" ? `/${sanitize(state.mode.draft)}▏` : state.notice ?? filterSummary(state);

  let body: ReactNode;
  if (state.mode.kind === "help") {
    body = <Dialog title="操作" width={Math.min(columns, 60)} height={bodyHeight} lines={helpLines.map((text) => ({ text }))} />;
  } else if (state.mode.kind === "jobPicker") {
    const mode = state.mode;
    const options = ["全案件", ...jobs];
    body = (
      <Dialog
        title="案件を選択"
        width={Math.min(columns, 60)}
        height={bodyHeight}
        lines={options.map((name, optionIndex) => ({ text: `${optionIndex === mode.index ? ">" : " "} ${sanitize(name)}`, selected: optionIndex === mode.index }))}
      />
    );
  } else if (state.mode.kind === "filter" && state.tab !== "issues") {
    const mode = state.mode;
    body = (
      <Dialog
        title={`${tabLabels[state.tab]} の状態`}
        width={Math.min(columns, 60)}
        height={bodyHeight}
        lines={statusOrder[state.tab].map((value, optionIndex) => ({ text: `${optionIndex === mode.index ? ">" : " "} [${mode.draft.includes(value) ? "x" : " "}] ${value}`, selected: optionIndex === mode.index }))}
      />
    );
  } else {
    body = (
      <Box flexDirection="row" height={bodyHeight}>
        {layout === "wide" && (
          <PanelBox title="案件" focused={focus === "jobs"} width={jobsWidth} height={bodyHeight}>
            <JobRows snapshot={snapshot} job={state.job} width={jobsWidth - 2} height={innerHeight} />
          </PanelBox>
        )}
        {(layout !== "narrow" || !state.narrowDetail) && (
          <PanelBox title={tabs} focused={focus === "list"} width={listWidth} height={bodyHeight}>
            <ListRows rows={list} index={index} width={listWidth - 2} height={innerHeight} />
          </PanelBox>
        )}
        {(layout !== "narrow" || state.narrowDetail) && (
          <PanelBox title={`詳細${detail.loading && record ? " (読み込み中)" : ""}`} focused={focus === "detail"} width={detailWidth} height={bodyHeight}>
            <DetailView lines={lines} scroll={scroll} height={innerHeight} width={detailInner} />
          </PanelBox>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text wrap="truncate-end">
        <Text bold>{header}</Text>
        <Text color={status.color}>{status.text}</Text>
      </Text>
      {body}
      <Text wrap="truncate-end">{truncate(notice || " ", columns)}</Text>
      <Text dimColor wrap="truncate-end">
        {truncate(keyHints(state, panels), columns)}
      </Text>
    </Box>
  );
}

export { initialState };
