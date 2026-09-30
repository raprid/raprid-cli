// 更新操作のフォームの描画。状態遷移は actions.ts にある。

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { blockedList, needsCheck } from "./actions.js";
import { editorText, layoutEditor } from "./editor.js";
import type { AnswerForm, Mode, MoveForm, StepForm, UiState } from "./model.js";
import { confirmLines, evidenceRows, evidenceWindow, isAcceptanceDecision } from "./steps.js";
import { phaseLabels, stepLabel } from "./workflow.js";
import { sanitize, truncate, wrap } from "./text.js";
import { type QaRecord, type Snapshot, statusOrder } from "./types.js";

function Button(props: { label: string; focused: boolean }) {
  return (
    <Text inverse={props.focused} bold={props.focused}>
      {props.focused ? `>[ ${props.label} ]<` : ` [ ${props.label} ] `}
    </Text>
  );
}

function Frame(props: { title: string; width: number; height: number; children: ReactNode }) {
  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="double" borderColor="cyan">
      <Text bold wrap="truncate-end">
        ▶ {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

function Lines(props: { lines: string[]; width: number; color?: string; dim?: boolean; max?: number }) {
  const wrapped = props.lines.flatMap((line) => wrap(sanitize(line), props.width));
  const shown = props.max === undefined ? wrapped : wrapped.slice(0, props.max);
  const hidden = wrapped.length - shown.length;
  return (
    <>
      {shown.map((line, index) => (
        <Text key={index} color={props.color} dimColor={props.dim} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>…他 {hidden} 行</Text>}
    </>
  );
}

function questionOf(snapshot: Snapshot | undefined, form: AnswerForm): string {
  const qa = snapshot?.qas.find((record: QaRecord) => record.path === form.target.path);
  return qa?.question ?? form.target.title;
}

function AnswerView(props: { form: AnswerForm; state: UiState; snapshot: Snapshot | undefined; width: number; height: number }) {
  const { form, width } = props;
  const inner = width - 2;
  const latest = form.latest ?? [];
  const reserved = 1 + 2 + 1 + 1 + (form.error ? 2 : 0) + Math.min(latest.length, 6); // 題・質問・ボタン・余白・エラー・最新
  const editorHeight = Math.max(3, props.height - 2 - reserved - 2);
  const rows = layoutEditor(form.editor, inner - 2, editorHeight);
  const bytes = Buffer.byteLength(editorText(form.editor), "utf8");
  return (
    <Frame title={`${form.target.id} への回答  案件 ${sanitize(form.target.job)}  回答者 ${props.state.actor}`} width={width} height={props.height}>
      <Lines lines={[`質問: ${questionOf(props.snapshot, form)}`]} width={inner} dim max={2} />
      <Box flexDirection="column" borderStyle={form.focus === "editor" ? "bold" : "single"} width={inner} height={editorHeight + 2}>
        {rows.map((row, index) => (
          <Text key={index} wrap="truncate-end">
            {row.before}
            {row.cursor !== undefined && form.focus === "editor" ? <Text inverse>{row.cursor}</Text> : (row.cursor ?? "")}
            {row.after}
          </Text>
        ))}
      </Box>
      {form.discard ? (
        <Text color="yellow" bold>
          入力中の回答を破棄{form.discard === "exit" ? "して終了" : ""}しますか？ y: 破棄する  n: 編集に戻る
        </Text>
      ) : (
        <Text>
          <Button label="保存" focused={form.focus === "save"} />
          <Button label="取消" focused={form.focus === "cancel"} />
          <Text dimColor>  {form.editor.lines.length} 行 / {bytes} バイト</Text>
        </Text>
      )}
      {form.error && <Lines lines={[form.error]} width={inner} color="red" max={2} />}
      {latest.length > 0 && <Lines lines={latest} width={inner} color="yellow" max={6} />}
    </Frame>
  );
}

function ConfirmAnswerView(props: { mode: Extract<Mode, { kind: "answerConfirm" }>; state: UiState; snapshot: Snapshot | undefined; width: number; height: number }) {
  const { form } = props.mode;
  const inner = props.width - 2;
  const answer = editorText(form.editor).split("\n");
  return (
    <Frame title="この内容で回答を保存しますか？" width={props.width} height={props.height}>
      <Lines lines={[`案件    ${form.target.job}`, `QA      ${form.target.id}  ${questionOf(props.snapshot, form)}`, `回答者  ${props.state.actor}`, `回答内容 (${answer.length} 行):`]} width={inner} max={5} />
      <Lines lines={answer.map((line) => `  ${line}`)} width={inner} max={Math.max(1, props.height - 10)} />
      <Text>
        <Button label="保存する" focused={props.mode.focus === "ok"} />
        <Button label="戻る" focused={props.mode.focus === "back"} />
      </Text>
    </Frame>
  );
}

const blockerText = { resolved: "✓ 解決済み", unresolved: "✗ 未解決", missing: "✗ 見つからない", other: "? 解消したか確認してください" };

function MoveView(props: { form: MoveForm; state: UiState; width: number; height: number }) {
  const { form } = props;
  const inner = props.width - 2;
  const target = statusOrder.task[form.index];
  const head = `${form.target.id} の状態を変更  (現在: ${form.target.status})  操作者 ${props.state.actor}`;
  let body: ReactNode;
  if (form.stage === "status") {
    body = (
      <>
        <Lines lines={[sanitize(form.target.title)]} width={inner} dim max={2} />
        {statusOrder.task.map((status, index) => (
          <Text key={status} inverse={index === form.index}>
            {index === form.index ? ">" : " "} {status}
            {status === form.target.status ? " (現在)" : ""}
          </Text>
        ))}
      </>
    );
  } else if (form.stage === "blocked") {
    const rows = layoutEditor(form.blocked, inner - 2, Math.max(3, props.height - 8));
    body = (
      <>
        <Text>待っている相手を 1 行に 1 件ずつ入力してください (qa/Q-001、qa/&lt;案件名&gt;/Q-001、task/T-001、other: …)</Text>
        <Box flexDirection="column" borderStyle={form.blockedFocus === "editor" ? "bold" : "single"} width={inner}>
          {rows.map((row, index) => (
            <Text key={index} wrap="truncate-end">
              {row.before}
              {row.cursor !== undefined && form.blockedFocus === "editor" ? <Text inverse>{row.cursor}</Text> : (row.cursor ?? "")}
              {row.after}
            </Text>
          ))}
        </Box>
        <Text>
          <Button label="次へ" focused={form.blockedFocus === "next"} />
          <Button label="戻る" focused={form.blockedFocus === "back"} />
          <Text dimColor>  {blockedList(form).length} 件</Text>
        </Text>
      </>
    );
  } else {
    const lines = [`案件  ${form.target.job}`, `ID    ${form.target.id}  ${form.target.title}`, `変更  ${form.target.status} → ${target}`];
    if (target === "pending") lines.push("待ち:", ...blockedList(form).map((value) => `  ${value}`));
    if (form.blockers.length > 0) lines.push("解除する待ち:", ...form.blockers.map((blocker) => `  ${blockerText[blocker.state]}  ${blocker.reference}`));
    const check = target === "done" ? "完了条件を満たしたことを確認した" : "上記の QA 以外の待ちが解消したことを確認した";
    body = (
      <>
        <Text bold>この内容で状態を変更しますか？ (QA を解決しても自動では再開しません)</Text>
        <Lines lines={lines} width={inner} max={Math.max(3, props.height - 9)} />
        {needsCheck(form) && (
          <Text>
            [{form.checked ? "x" : " "}] {check} (Space で切替)
          </Text>
        )}
        <Text>
          <Button label="変更する" focused={form.focus === "ok"} />
          <Button label="戻る" focused={form.focus === "back"} />
        </Text>
      </>
    );
  }
  return (
    <Frame title={head} width={props.width} height={props.height}>
      {body}
      {form.error && <Lines lines={[form.error]} width={inner} color="red" max={3} />}
      {form.latest && <Lines lines={form.latest} width={inner} color="yellow" max={4} />}
    </Frame>
  );
}

function EditorBox(props: { editor: Parameters<typeof layoutEditor>[0]; focused: boolean; width: number; height: number }) {
  const rows = layoutEditor(props.editor, props.width - 2, props.height);
  return (
    <Box flexDirection="column" borderStyle={props.focused ? "bold" : "single"} width={props.width}>
      {rows.map((row, index) => (
        <Text key={index} wrap="truncate-end">
          {row.before}
          {row.cursor !== undefined && props.focused ? <Text inverse>{row.cursor}</Text> : (row.cursor ?? "")}
          {row.after}
        </Text>
      ))}
    </Box>
  );
}

// 受入確認の根拠。すべての行をスクロールして見られ、最後まで表示しないと確認欄に印を付けられない (R15-1)
function Evidence(props: { form: StepForm; width: number; height: number }) {
  const { form } = props;
  const rows = evidenceRows(form.record, props.width);
  const window = evidenceWindow(props.height);
  const shown = rows.slice(form.evidenceScroll, form.evidenceScroll + window);
  const end = Math.min(rows.length, form.evidenceScroll + window);
  return (
    <>
      <Text bold>
        根拠 ({form.evidenceScroll + 1}〜{end} / {rows.length} 行{rows.length > window ? "  ↑↓ PgUp/PgDn でスクロール" : ""})
      </Text>
      {shown.map((line, index) => (
        <Text key={index} color="cyan" wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
      <Text color={form.evidenceSeen ? undefined : "yellow"}>
        [{form.checked ? "x" : " "}] 実行の成果物 (対象の commit・資料) とレビューの結果を確かめた (Space で切替)
        {form.evidenceSeen ? "" : "  ※ 根拠を最後まで表示すると印を付けられます"}
      </Text>
    </>
  );
}

// 工程の操作: 選択 → 入力 → 確認。受入確認の判定は根拠 (実行の成果物・レビュー) を示し、確認欄に印を付けてから確定する
function StepView(props: { form: StepForm; state: UiState; width: number; height: number }) {
  const { form } = props;
  const inner = props.width - 2;
  const record = form.record;
  const where = record.status === "closed" ? "closed" : `${phaseLabels[record.phase ?? ""] ?? record.phase} ${record.phaseStatus} / 担当 ${record.assignee ?? "未割当"}`;
  const head = `${form.target.id} の工程の操作  (${where})  操作者 ${props.state.actor}`;
  let body: ReactNode;
  if (form.stage === "menu") {
    body = (
      <>
        <Lines lines={[sanitize(form.target.title), "今の状態と操作者でできる操作だけを表示しています (状態を直接は選べません)"]} width={inner} dim max={3} />
        {form.steps.map((step, index) => (
          <Text key={step} inverse={index === form.index}>
            {index === form.index ? ">" : " "} {stepLabel(step, record.phase)}
          </Text>
        ))}
      </>
    );
  } else if (form.stage === "edit") {
    const multi = form.fields.filter((field) => field.kind === "lines").length;
    const room = Math.max(2, Math.floor((props.height - 6 - form.fields.length * 2) / Math.max(1, multi)));
    body = (
      <>
        <Text bold>{stepLabel(form.step!, record.phase)}</Text>
        {form.fields.map((field, index) => (
          <Box key={field.key} flexDirection="column">
            <Text bold={index === form.focus}>
              {index === form.focus ? "> " : "  "}
              {field.label}
              {field.required ? " *" : ""}
              {field.hint ? <Text dimColor>  {field.hint}</Text> : null}
            </Text>
            {field.kind === "choice" ? (
              <Text>
                {"  "}
                {field.choices!.map((value, choice) => (
                  <Text key={value} inverse={choice === field.choice}>
                    {` ${value} `}
                  </Text>
                ))}
                <Text dimColor>  ←→ で選択</Text>
              </Text>
            ) : (
              <EditorBox editor={field.editor} focused={index === form.focus} width={inner} height={field.kind === "lines" ? room : 1} />
            )}
          </Box>
        ))}
        <Text>
          <Button label="次へ" focused={form.focus === form.fields.length} />
          <Button label="戻る" focused={form.focus === form.fields.length + 1} />
        </Text>
      </>
    );
  } else {
    const acceptance = isAcceptanceDecision(form);
    body = (
      <>
        <Text bold>{acceptance ? "受入確認: 次の根拠を確かめてから確定してください (人の最終確認)" : "この内容で保存しますか？"}</Text>
        <Lines lines={confirmLines(form)} width={inner} max={acceptance ? 6 : Math.max(3, props.height - 8)} />
        {acceptance && <Evidence form={form} width={props.width} height={props.height} />}
        <Text>
          <Button label={acceptance ? (form.step === "approve" ? "受け入れる" : "差し戻す") : "保存する"} focused={form.confirmFocus === "ok"} />
          <Button label="戻る" focused={form.confirmFocus === "back"} />
        </Text>
      </>
    );
  }
  return (
    <Frame title={head} width={props.width} height={props.height}>
      {body}
      {form.error && <Lines lines={[form.error]} width={inner} color="red" max={3} />}
      {form.latest && <Lines lines={form.latest} width={inner} color="yellow" max={4} />}
    </Frame>
  );
}

export function FormView(props: { state: UiState; snapshot: Snapshot | undefined; width: number; height: number }) {
  const { state, width, height } = props;
  const mode = state.mode;
  switch (mode.kind) {
    case "actor":
      return (
        <Frame title="更新する人" width={width} height={height}>
          <Text>更新する人を human/&lt;識別子&gt; で入力してください。このセッションの間だけ使い、確認画面に表示します。</Text>
          <Text>
            &gt; {mode.draft}
            <Text inverse> </Text>
          </Text>
          {mode.error && <Text color="red">{mode.error}</Text>}
        </Frame>
      );
    case "answer":
      return <AnswerView form={mode} state={state} snapshot={props.snapshot} width={width} height={height} />;
    case "answerConfirm":
      return <ConfirmAnswerView mode={mode} state={state} snapshot={props.snapshot} width={width} height={height} />;
    case "move":
      return <MoveView form={mode} state={state} width={width} height={height} />;
    case "step":
      return <StepView form={mode} state={state} width={width} height={height} />;
    case "saving": {
      const request = mode.request;
      const what =
        request.type === "answer"
          ? `${request.target.id} に回答しています`
          : request.type === "workflow"
            ? `${request.target.id} を「${stepLabel(request.kind, undefined)}」しています`
            : `${request.target.id} を ${request.status} に変更しています`;
      return (
        <Frame title="保存中" width={width} height={height}>
          <Text>{what}…</Text>
          <Text dimColor>保存が終わるまで操作と終了を受け付けません{mode.exitRequested ? " (終了の要求を受け付けました。保存の完了後に終了します)" : ""}</Text>
        </Frame>
      );
    }
    case "resumeList":
      return (
        <Frame title={`${mode.qa} を待っていたタスク (自動では再開しません)`} width={width} height={height}>
          {mode.tasks.map((task, index) => (
            <Text key={task.path} inverse={index === mode.index} wrap="truncate-end">
              {index === mode.index ? ">" : " "} {task.id ?? task.name}  {sanitize(task.job)}  {sanitize(task.title)}
            </Text>
          ))}
          <Text dimColor>Enter で一覧のそのタスクへ移動し、m で状態を変更して再開します</Text>
        </Frame>
      );
    default:
      return null;
  }
}

export function formHints(state: UiState): string | undefined {
  const mode = state.mode;
  switch (mode.kind) {
    case "actor":
      return "human/<識別子> を入力  Enter 決定  Esc 取消";
    case "answer":
      if (mode.discard) return "y 破棄する  n 編集に戻る";
      return mode.focus === "editor" ? "Enter 改行  Tab ボタンへ  ←→↑↓ カーソル  貼り付け可  Esc 取消" : "Enter 実行  Tab / ←→ 切替  Esc 取消";
    case "answerConfirm":
      return "Enter 実行  Tab / ←→ 切替  Esc 編集に戻る";
    case "move":
      if (mode.stage === "status") return "↑↓ 遷移先を選択  Enter 次へ  Esc 取消";
      if (mode.stage === "blocked") return mode.blockedFocus === "editor" ? "1 行に 1 件  Enter 次の行  Tab 次へ/戻る  Esc 戻る" : "Enter 実行  Tab / ←→ 切替  Esc 戻る";
      return "Space 確認欄  Tab / ←→ 切替  Enter 実行  Esc 戻る";
    case "step":
      if (mode.stage === "menu") return "↑↓ 操作を選択  Enter 次へ  Esc 取消";
      if (mode.stage === "edit") return "Tab 次の欄  ←→ 選択・カーソル  Enter 次の欄 (複数行の欄は改行)  貼り付け可  Esc 操作の選択へ";
      return isAcceptanceDecision(mode) ? "↑↓ PgUp/PgDn 根拠をスクロール  Space 確認欄  Tab / ←→ 切替  Enter 確定  Esc 戻る" : "Enter 実行  Tab / ←→ 切替  Esc 戻る";
    case "saving":
      return "保存中…";
    case "resumeList":
      return "↑↓ 選択  Enter 一覧へ移動  Esc 閉じる";
    default:
      return undefined;
  }
}
