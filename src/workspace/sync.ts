import { existsSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  config,
  document,
  equal,
  hash,
  ids,
  issuePath,
  read,
  safe,
  saveDocument,
  write,
  atomic,
  textFile,
  validate,
  type Document,
  type Remote,
  writeBatch,
} from "./store.js";
import {
  endpoint,
  normalize,
  remoteInfo,
  patch,
  ApiError,
  type Api,
} from "./github.js";

export interface Conflict {
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}
export function merge(
  base: any,
  local: any,
  remote: any,
): { value: any; conflicts: Conflict[] } {
  const value: any = {},
    conflicts: Conflict[] = [];
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const b = base[key],
      l = local[key],
      r = remote[key];
    if (equal(l, b)) value[key] = r;
    else if (equal(r, b) || equal(l, r)) value[key] = l;
    else if (
      ["labels", "assignees"].includes(key) &&
      [b, l, r].every(Array.isArray)
    ) {
      value[key] = [...new Set([...l, ...r])]
        .filter((x) => !(b.includes(x) && (!l.includes(x) || !r.includes(x))))
        .sort();
    } else {
      value[key] = l;
      conflicts.push({ field: key, base: b, local: l, remote: r });
    }
  }
  return { value, conflicts };
}
const flat = (d: Document) => ({ ...d.issue, body: d.body });
const unflat = (d: any): Document => {
  const { body, ...issue } = d;
  return { issue, body };
};
const syncDir = (id: string) => `.raprid/sync/issues/${id}`;
export function pendingOperations(root: string): any[] {
  const p = safe(root, ".raprid/sync/operations");
  return existsSync(p)
    ? readdirSync(p)
        .filter((x) => x.endsWith(".json"))
        .map((x) => read<any>(root, `.raprid/sync/operations/${x}`))
        .filter((x) => ["sending", "unknown", "responded"].includes(x.status))
    : [];
}
export function status(root: string): any {
  return {
    issues: ids(root).map((id) => {
      try {
        const current = document(root, id),
          base = read<Document | null>(
            root,
            `${syncDir(id)}/base/document.json`,
            null,
          ),
          conflicts = read<any[]>(
            root,
            `${syncDir(id)}/conflicts/document.json`,
            [],
          );
        const resources = ["relations", "fields", "comments"].filter((name) =>
          resourceDirty(root, id, name),
        );
        return {
          id,
          number:
            read<Remote | null>(root, `${issuePath(id)}/remote.json`, null)
              ?.number ?? null,
          title: current.issue.title,
          state: current.issue.state,
          dirty:
            !base || !equal(flat(current), flat(base)) || resources.length > 0,
          resources,
          conflicts:
            conflicts.length +
            ["relations", "fields"].reduce(
              (n, name) =>
                n +
                read<any[]>(root, `${syncDir(id)}/conflicts/${name}.json`, [])
                  .length,
              0,
            ),
          fetched: read<any>(root, `${syncDir(id)}/state.json`, null),
        };
      } catch (e) {
        return { id, error: String(e) };
      }
    }),
    operations: pendingOperations(root),
  };
}
function resourceDirty(root: string, id: string, name: string): boolean {
  if (name === "comments")
    return comments(root, id).some((c) => {
      const base = read<any>(
        root,
        `${syncDir(id)}/base/comments/${c.id}.json`,
        null,
      );
      return !base || base.body !== c.body;
    });
  const local = read<any>(root, `${issuePath(id)}/${name}.json`, null),
    base = read<any>(root, `${syncDir(id)}/base/${name}.json`, null);
  return local !== null && !equal(local, base);
}
function integrate(root: string, id: string, raw: any): void {
  const remote = normalize(raw),
    base = read<Document | null>(
      root,
      `${syncDir(id)}/base/document.json`,
      null,
    );
  write(root, `${syncDir(id)}/remote/document.json`, remote);
  const local = existsSync(safe(root, `${issuePath(id)}/issue.json`))
    ? document(root, id)
    : remote;
  const merged = base
    ? merge(flat(base), flat(local), flat(remote))
    : { value: flat(local), conflicts: [] };
  // 同期基点を進める前に、競合の旧基点を永続化する。
  const old = read<Conflict[]>(
    root,
    `${syncDir(id)}/conflicts/document.json`,
    [],
  );
  const conflicts = [
    ...old.filter(
      (c) =>
        !equal((flat(local) as any)[c.field], (flat(remote) as any)[c.field]),
    ),
    ...merged.conflicts,
  ].filter((c, i, a) => a.findIndex((x) => x.field === c.field) === i);
  const mergedDoc = unflat(merged.value);
  validate(mergedDoc.issue);
  writeBatch(root, {
    [`${syncDir(id)}/conflicts/document.json`]: JSON.stringify(conflicts),
    [`${issuePath(id)}/issue.json`]:
      JSON.stringify(mergedDoc.issue, null, 2) + "\n",
    [`${issuePath(id)}/index.md`]: mergedDoc.body,
    [`${issuePath(id)}/remote.json`]:
      JSON.stringify(remoteInfo(config(root), raw), null, 2) + "\n",
    [`${syncDir(id)}/base/document.json`]: JSON.stringify(remote),
  });
}
export async function pull(root: string, api: Api): Promise<any> {
  const c = config(root),
    ep = endpoint(c),
    list = await api.list(`${ep}/issues?state=all&sort=created&direction=asc`),
    result: any[] = [];
  for (const raw of list.filter((x) => !x.pull_request)) {
    const matches = ids(root).filter(
      (id) =>
        read<Remote | null>(root, `${issuePath(id)}/remote.json`, null)?.id ===
        raw.id,
    );
    if (matches.length > 1)
      throw new Error(`GitHub IDが重複しています: ${raw.id}`);
    if (
      !matches.length &&
      pendingOperations(root).some(
        (op) => op.method === "POST" && op.path === `${ep}/issues`,
      )
    ) {
      result.push({
        number: raw.number,
        status: "新規作成の結果確認待ちのため取り込み保留",
      });
      continue;
    }
    const id = matches[0] ?? randomUUID();
    if (pendingOperations(root).some((op) => op.issueId === id)) {
      result.push({ id, status: "結果確認待ち" });
      continue;
    }
    integrate(root, id, raw);
    const state: any = {
      fetchedAt: new Date().toISOString(),
      document: "fetched",
    };
    await pullComments(root, id, api, `${ep}/issues/${raw.number}`, state);
    await pullResources(root, id, api, `${ep}/issues/${raw.number}`, state);
    write(root, `${syncDir(id)}/state.json`, state);
    result.push({ id, number: raw.number, ...state });
  }
  for (const [name, path] of Object.entries({
    labels: `${ep}/labels`,
    milestones: `${ep}/milestones?state=all`,
  })) {
    try {
      write(root, `.raprid/catalog/${name}.json`, await api.list(path));
    } catch (e) {
      result.push({ catalog: name, error: String(e) });
    }
  }
  for (const [name, path] of Object.entries({
    repository: ep,
    "issue-types": `orgs/${c.repository.split("/")[0]}/issue-types`,
    "issue-fields": `orgs/${c.repository.split("/")[0]}/issue-fields`,
  })) {
    try {
      write(
        root,
        `.raprid/catalog/${name}.json`,
        name === "repository"
          ? await api.request("GET", path)
          : await api.list(path),
      );
    } catch (e) {
      write(root, `.raprid/catalog/${name}-status.json`, {
        status: "unavailable",
        error: String(e),
      });
    }
  }
  return result;
}
function resourceMerge(
  root: string,
  id: string,
  name: string,
  remote: any,
): void {
  const path = `${issuePath(id)}/${name}.json`,
    local = read<any>(root, path, null),
    base = read<any>(root, `${syncDir(id)}/base/${name}.json`, null);
  write(root, `${syncDir(id)}/remote/${name}.json`, remote);
  if (local === null || equal(local, base) || equal(local, remote)) {
    write(root, path, remote);
    write(root, `${syncDir(id)}/base/${name}.json`, remote);
    write(root, `${syncDir(id)}/conflicts/${name}.json`, []);
  } else if (!equal(base, remote))
    write(root, `${syncDir(id)}/conflicts/${name}.json`, [
      { base, local, remote },
    ]);
}
async function pullResources(
  root: string,
  id: string,
  api: Api,
  path: string,
  state: any,
): Promise<void> {
  try {
    let parent: any = null;
    try {
      parent = await api.request("GET", `${path}/parent`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    const children = await api.list(`${path}/sub_issues`),
      blockedBy = await api.list(`${path}/dependencies/blocked_by`);
    const ref = (x: any) => ({ id: x.id, number: x.number, url: x.html_url });
    resourceMerge(root, id, "relations", {
      schemaVersion: 1,
      parent: parent ? ref(parent) : null,
      children: children.map(ref),
      blockedBy: blockedBy.map(ref),
    });
    state.relations = "fetched";
  } catch (e) {
    state.relations = { status: "unavailable", error: String(e) };
  }
  try {
    const fields = await api.list(`${path}/issue-field-values`);
    resourceMerge(root, id, "fields", normalizeFields(fields));
    state.fields = "fetched";
  } catch (e) {
    state.fields = { status: "unavailable", error: String(e) };
  }
}
export function comments(
  root: string,
  id: string,
): { id: string; body: string; meta: any }[] {
  const path = `${issuePath(id)}/comments`;
  if (!existsSync(safe(root, path))) return [];
  return readdirSync(safe(root, path))
    .filter((x) => !x.startsWith("."))
    .map((cid) => {
      issuePath(cid);
      return {
        id: cid,
        body: textFile(root, `${path}/${cid}/index.md`),
        meta: read(root, `${path}/${cid}/metadata.json`),
      };
    });
}
export function addComment(root: string, id: string, body: string): string {
  if (!body.trim()) throw new Error("コメント本文が空です");
  const cid = randomUUID(),
    path = `${issuePath(id)}/comments/${cid}`;
  writeBatch(root, {
    [`${path}/metadata.json`]: JSON.stringify({
      schemaVersion: 1,
      remote: null,
    }),
    [`${path}/index.md`]: body,
  });
  return cid;
}
async function pullComments(
  root: string,
  id: string,
  api: Api,
  path: string,
  state: any,
): Promise<void> {
  try {
    const list = await api.list(`${path}/comments`);
    for (const raw of list) {
      const cid =
          comments(root, id).find((x) => x.meta.remote?.id === raw.id)?.id ??
          randomUUID(),
        p = `${issuePath(id)}/comments/${cid}`;
      const base = read<any>(
          root,
          `${syncDir(id)}/base/comments/${cid}.json`,
          null,
        ),
        local = existsSync(safe(root, `${p}/index.md`))
          ? textFile(root, `${p}/index.md`)
          : raw.body;
      write(root, `${syncDir(id)}/remote/comments/${cid}.json`, raw);
      const changes: Record<string, string> = {
        [`${p}/metadata.json`]: JSON.stringify({
          schemaVersion: 1,
          remote: raw,
        }),
      };
      if (!base || local === base.body || local === raw.body) {
        changes[`${p}/index.md`] = raw.body;
        changes[`${syncDir(id)}/base/comments/${cid}.json`] =
          JSON.stringify(raw);
        changes[`${syncDir(id)}/conflicts/comment-${cid}.json`] = "[]";
      } else if (base.body !== raw.body)
        changes[`${syncDir(id)}/conflicts/comment-${cid}.json`] =
          JSON.stringify([{ base: base.body, local, remote: raw.body }]);
      writeBatch(root, changes);
    }
    state.comments = "fetched";
  } catch (e) {
    state.comments = { status: "unavailable", error: String(e) };
  }
}
export async function mutation(
  root: string,
  id: string,
  api: Api,
  method: string,
  path: string,
  body: unknown,
  context: Record<string, unknown> = {},
): Promise<any> {
  if (pendingOperations(root).some((op) => op.issueId === id))
    throw new Error(
      `${id}: 結果確認待ちの操作があります。sync reconcileを実行してください`,
    );
  const op = {
      id: randomUUID(),
      issueId: id,
      method,
      path,
      body,
      ...context,
      local: document(root, id),
      base: read<Document | null>(
        root,
        `${syncDir(id)}/base/document.json`,
        null,
      ),
      status: "sending",
      at: new Date().toISOString(),
    },
    file = `.raprid/sync/operations/${op.id}.json`;
  write(root, file, op);
  try {
    const response = await api.request(method, path, body);
    write(root, file, {
      ...op,
      status: "responded",
      response,
      finishedAt: new Date().toISOString(),
    });
    return response;
  } catch (e) {
    const definite =
      e instanceof ApiError &&
      [400, 401, 403, 404, 410, 422].includes(e.status);
    write(root, file, {
      ...op,
      status: definite ? "failed" : "unknown",
      error: String(e),
    });
    throw e;
  }
}
export async function push(
  root: string,
  api: Api,
  dryRun = false,
  expectedRevision?: string,
): Promise<any[]> {
  if (expectedRevision && localRevision(root) !== expectedRevision)
    throw new Error("プレビュー後に変更されています。差分を再確認してください");
  const initial = new Map(ids(root).map((id) => [id, itemRevision(root, id)]));
  const c = config(root),
    ep = endpoint(c),
    result: any[] = [];
  for (const id of initial.keys()) {
    if (itemRevision(root, id) !== initial.get(id))
      throw new Error("同期中に別の操作で編集されています");
    const resourcesObserved = resourceRevision(root, id);
    const observed = document(root, id);
    let local = observed,
      remote = read<Remote | null>(root, `${issuePath(id)}/remote.json`, null);
    if (pendingOperations(root).some((x) => x.issueId === id))
      throw new Error(`${id}: 送信結果確認待ちです`);
    let base = read<Document | null>(
      root,
      `${syncDir(id)}/base/document.json`,
      null,
    );
    if (remote) {
      const latest = await api.request("GET", `${ep}/issues/${remote.number}`);
      if (latest.id !== remote.id)
        throw new Error("Issueの識別子が変わっています");
      const incoming = normalize(latest);
      if (!base) throw new Error("同期基点がありません");
      const merged = merge(flat(base), flat(local), flat(incoming));
      const unresolved = read<Conflict[]>(
        root,
        `${syncDir(id)}/conflicts/document.json`,
        [],
      );
      if (merged.conflicts.length || unresolved.length) {
        if (!dryRun) integrate(root, id, latest);
        throw new Error(
          `${id}: 本文・属性に競合があります。sync resolveを実行してください`,
        );
      }
      local = unflat(merged.value);
      base = incoming;
      if (!dryRun) integrate(root, id, latest);
    }
    validate(local.issue);
    const changes = patch(base, local);
    if (changes.state_reason === "duplicate")
      throw new Error("duplicateへの変更はGitHub上で実行してpullしてください");
    if (!remote) {
      for (const name of ["relations", "fields"])
        if (resourceDirty(root, id, name))
          throw new Error(
            `${name}: Issueを作成してpullした後に編集してください`,
          );
      if (dryRun)
        for (const comment of comments(root, id))
          result.push({
            id,
            action: "create-comment-after-issue",
            comment: comment.id,
            body: comment.body,
          });
    }
    if (Object.keys(changes).length) {
      result.push({ id, action: remote ? "update" : "create", changes });
      if (!dryRun) {
        const beforeSend = document(root, id);
        if (!equal(flat(beforeSend), flat(local)))
          throw new Error(
            "送信前にローカル内容が変わりました。再度差分を確認してください",
          );
        const response = await mutation(
          root,
          id,
          api,
          remote ? "PATCH" : "POST",
          remote ? `${ep}/issues/${remote.number}` : `${ep}/issues`,
          changes,
        );
        const actual = normalize(response);
        // APIが権限不足等で無視した項目は、基点との差分として残す。
        write(root, `${issuePath(id)}/remote.json`, remoteInfo(c, response));
        write(root, `${syncDir(id)}/base/document.json`, actual);
        remote = response;
        settle(root, id);
        if (!equal(flat(actual), flat(local))) {
          if (equal(flat(document(root, id)), flat(beforeSend)))
            saveDocument(root, id, local);
          throw new Error(
            `${id}: GitHubの応答が送信内容と一致しません。未反映の変更を保持しました`,
          );
        }
        if (equal(flat(document(root, id)), flat(beforeSend)))
          saveDocument(root, id, actual);
      }
    }
    if (resourceRevision(root, id) !== resourcesObserved)
      throw new Error("同期中にコメント・関係・属性が編集されています");
    if (remote) {
      await pushComments(root, id, api, ep, remote, result, dryRun);
      await pushResources(root, id, api, ep, remote, result, dryRun);
    }
  }
  return result;
}
async function pushComments(
  root: string,
  id: string,
  api: Api,
  ep: string,
  remote: Remote,
  result: any[],
  dry: boolean,
): Promise<void> {
  for (const c of comments(root, id)) {
    const base = read<any>(
      root,
      `${syncDir(id)}/base/comments/${c.id}.json`,
      null,
    );
    if (base?.body === c.body) continue;
    const path = c.meta.remote
      ? `${ep}/issues/comments/${c.meta.remote.id}`
      : `${ep}/issues/${remote.number}/comments`;
    if (c.meta.remote) {
      const latest = await api.request("GET", path);
      if (!base || (latest.body !== base.body && latest.body !== c.body)) {
        if (!dry) {
          write(root, `${syncDir(id)}/remote/comments/${c.id}.json`, latest);
          write(root, `${syncDir(id)}/conflicts/comment-${c.id}.json`, [
            { base: base?.body, local: c.body, remote: latest.body },
          ]);
        }
        throw new Error(`コメント競合: ${c.id}`);
      }
    }
    result.push({ id, comment: c.id, body: c.body });
    if (dry) continue;
    const raw = await mutation(
      root,
      id,
      api,
      c.meta.remote ? "PATCH" : "POST",
      path,
      { body: c.body },
      { commentLocalId: c.id },
    );
    write(root, `${issuePath(id)}/comments/${c.id}/metadata.json`, {
      schemaVersion: 1,
      remote: raw,
    });
    write(root, `${syncDir(id)}/base/comments/${c.id}.json`, raw);
    settle(root, id);
    if (raw.body !== c.body)
      throw new Error("コメントの反映結果が一致しません");
  }
}
export function resolveConflict(
  root: string,
  id: string,
  choice: string,
  resource = "document",
): void {
  if (!["document", "relations", "fields"].includes(resource))
    throw new Error("resourceはdocument/relations/fieldsです");
  if (!["local", "remote"].includes(choice))
    throw new Error("--take local|remote を指定してください");
  if (resource !== "document") {
    const incoming = read<any>(root, `${syncDir(id)}/remote/${resource}.json`);
    if (choice === "remote")
      write(root, `${issuePath(id)}/${resource}.json`, incoming);
    write(root, `${syncDir(id)}/base/${resource}.json`, incoming);
    write(root, `${syncDir(id)}/conflicts/${resource}.json`, []);
    return;
  }
  const incoming = read<Document>(root, `${syncDir(id)}/remote/document.json`);
  if (choice === "remote") saveDocument(root, id, incoming);
  write(root, `${syncDir(id)}/base/document.json`, incoming);
  write(root, `${syncDir(id)}/conflicts/document.json`, []);
}

export function settle(root: string, id: string): void {
  for (const op of pendingOperations(root).filter(
    (x) => x.issueId === id && x.status === "responded",
  ))
    write(root, `.raprid/sync/operations/${op.id}.json`, {
      ...op,
      status: "confirmed",
    });
}
export async function reconcile(
  root: string,
  api: Api,
  operation: string,
  remoteId?: number,
): Promise<any> {
  if (!/^[\w-]+$/.test(operation)) throw new Error("不正な操作IDです");
  const path = `.raprid/sync/operations/${operation}.json`,
    op = read<any>(root, path),
    ep = endpoint(config(root));
  if (!["sending", "unknown", "responded"].includes(op.status)) return op;
  let raw = op.response;
  if (
    op.path === `${ep}/issues` ||
    /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(op.path)
  ) {
    const known =
      op.method === "PATCH"
        ? Number(op.path.match(/issues\/(\d+)$/)?.[1])
        : undefined;
    if (known && remoteId && known !== remoteId)
      throw new Error("PATCHの照合先は変更できません");
    const number = known ?? raw?.number ?? remoteId;
    if (!number)
      throw new Error(
        "GitHubで作成結果を確認し、--remote-idにIssue番号を指定してください。未作成を確認できないため再送しません",
      );
    raw = await api.request("GET", `${ep}/issues/${number}`);
    const actual = normalize(raw),
      requested = op.body;
    if (
      known &&
      read<Remote>(root, `${issuePath(op.issueId)}/remote.json`).id !== raw.id
    )
      throw new Error("GitHub IDが一致しません");
    for (const [k, v] of Object.entries(requested)) {
      const field = k === "state_reason" ? "stateReason" : k;
      const got = k === "body" ? actual.body : (actual.issue as any)[field];
      if (!equal(got, v))
        throw new Error(
          "リモート内容と送信内容が一致しません。結果確認待ちを保持します",
        );
    }
    if (
      ids(root).some(
        (id) =>
          id !== op.issueId &&
          read<Remote | null>(root, `${issuePath(id)}/remote.json`, null)
            ?.id === raw.id,
      )
    )
      throw new Error(
        "別のローカルIssueに同じGitHub IDがあります。照合を停止しました",
      );
    const local = document(root, op.issueId);
    const merged = merge(flat(op.local ?? local), flat(local), flat(actual));
    write(
      root,
      `${syncDir(op.issueId)}/conflicts/document.json`,
      merged.conflicts,
    );
    saveDocument(root, op.issueId, unflat(merged.value));
    write(
      root,
      `${issuePath(op.issueId)}/remote.json`,
      remoteInfo(config(root), raw),
    );
    write(root, `${syncDir(op.issueId)}/base/document.json`, actual);
  } else if (/\/comments(?:\/\d+)?$/.test(op.path)) {
    const cid =
      raw?.id ?? remoteId ?? Number(op.path.match(/comments\/(\d+)$/)?.[1]);
    if (!cid)
      throw new Error("--remote-idにGitHubコメントIDを指定してください");
    raw = await api.request("GET", `${ep}/issues/comments/${cid}`);
    if (raw.body !== op.body.body)
      throw new Error("コメント内容が一致しません");
    const issueRemote = read<Remote>(
      root,
      `${issuePath(op.issueId)}/remote.json`,
    );
    const issueUrl = new URL(raw.issue_url);
    if (
      issueUrl.pathname !==
      `/repos/${config(root).repository}/issues/${issueRemote.number}`
    )
      throw new Error("別のIssueのコメントです");
    const matches = comments(root, op.issueId).filter(
      (c) => c.id === op.commentLocalId,
    );
    if (matches.length !== 1)
      throw new Error("ローカルコメントを一意に特定できません");
    write(
      root,
      `${issuePath(op.issueId)}/comments/${matches[0].id}/metadata.json`,
      { schemaVersion: 1, remote: raw },
    );
    write(
      root,
      `${syncDir(op.issueId)}/base/comments/${matches[0].id}.json`,
      raw,
    );
  } else {
    await reconcileResource(root, api, op);
  }
  write(root, path, {
    ...op,
    status: "confirmed",
    response: raw,
    reconciledAt: new Date().toISOString(),
  });
  return { operation, status: "confirmed" };
}
function normalizeFields(fields: any[]): any {
  return {
    schemaVersion: 1,
    values: fields
      .map((f) => ({
        fieldId: f.issue_field_id,
        value:
          f.data_type === "single_select"
            ? (f.single_select_option?.name ?? f.value)
            : f.data_type === "multi_select"
              ? (f.multi_select_options?.map((o: any) => o.name) ?? f.value)
              : f.value,
      }))
      .sort((a, b) => a.fieldId - b.fieldId),
  };
}
async function fetchRelations(api: Api, path: string): Promise<any> {
  let parent: any = null;
  try {
    parent = await api.request("GET", `${path}/parent`);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
  }
  const ref = (x: any) => ({ id: x.id, number: x.number, url: x.html_url });
  return {
    schemaVersion: 1,
    parent: parent ? ref(parent) : null,
    children: (await api.list(`${path}/sub_issues`)).map(ref),
    blockedBy: (await api.list(`${path}/dependencies/blocked_by`)).map(ref),
  };
}
function refPath(root: string, ref: any): string {
  if (ref.localId) {
    const raw = read<Remote | null>(
      root,
      `${issuePath(ref.localId)}/remote.json`,
      null,
    );
    if (!raw) throw new Error("参照先Issueを先に送信してください");
    ref = raw;
  }
  const c = config(root),
    url = new URL(ref.url ?? ref.html_url);
  const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
  if (
    url.protocol !== "https:" ||
    url.hostname !== c.host ||
    !match ||
    !Number.isInteger(ref.id)
  )
    throw new Error("Issue参照が不正です");
  return `repos/${match[1]}/issues/${match[2]}`;
}
async function pushResources(
  root: string,
  id: string,
  api: Api,
  ep: string,
  remote: Remote,
  result: any[],
  dry: boolean,
): Promise<void> {
  const path = `${ep}/issues/${remote.number}`;
  for (const name of ["relations", "fields"]) {
    if (!resourceDirty(root, id, name)) continue;
    let base = read<any>(root, `${syncDir(id)}/base/${name}.json`, null);
    const desired = read<any>(root, `${issuePath(id)}/${name}.json`);
    if (!base) throw new Error(`${name}: 先にpullで取得する必要があります`);
    const current =
      name === "relations"
        ? await fetchRelations(api, path)
        : normalizeFields(await api.list(`${path}/issue-field-values`));
    if (!equal(current, base) && !equal(current, desired)) {
      if (!dry) {
        write(root, `${syncDir(id)}/remote/${name}.json`, current);
        write(root, `${syncDir(id)}/conflicts/${name}.json`, [
          { base, local: desired, remote: current },
        ]);
      }
      throw new Error(`${name}: リモートと競合しています`);
    }
    if (equal(current, desired)) {
      if (!dry) write(root, `${syncDir(id)}/base/${name}.json`, current);
      continue;
    }
    const actions: { method: string; path: string; body?: any }[] = [];
    if (name === "fields") {
      if (
        desired.schemaVersion !== 1 ||
        !Array.isArray(desired.values) ||
        desired.values.some(
          (v: any) =>
            !Number.isInteger(v.fieldId) || !Object.hasOwn(v, "value"),
        ) ||
        new Set(desired.values.map((v: any) => v.fieldId)).size !==
          desired.values.length
      )
        throw new Error("fields.jsonの形式が不正です");
      for (const f of base.values)
        if (!desired.values.some((x: any) => x.fieldId === f.fieldId))
          actions.push({
            method: "DELETE",
            path: `${path}/issue-field-values/${f.fieldId}`,
          });
      for (const f of desired.values)
        if (!base.values.some((x: any) => equal(x, f)))
          actions.push({
            method: "PUT",
            path: `${path}/issue-field-values`,
            body: {
              issue_field_values: [{ field_id: f.fieldId, value: f.value }],
            },
          });
    } else {
      if (
        desired.schemaVersion !== 1 ||
        !Array.isArray(desired.children) ||
        !Array.isArray(desired.blockedBy) ||
        !Object.hasOwn(desired, "parent")
      )
        throw new Error("relations.jsonの形式が不正です");
      for (const list of [desired.children, desired.blockedBy]) {
        if (new Set(list.map((x: any) => x.id)).size !== list.length)
          throw new Error("関係参照が重複しています");
        for (const ref of list) {
          refPath(root, ref);
          if (ref.id === remote.id) throw new Error("自分自身への参照です");
        }
      }
      if (!equal(base.parent, desired.parent)) {
        if (base.parent)
          actions.push({
            method: "DELETE",
            path: `${refPath(root, base.parent)}/sub_issue`,
            body: { sub_issue_id: remote.id },
          });
        if (desired.parent)
          actions.push({
            method: "POST",
            path: `${refPath(root, desired.parent)}/sub_issues`,
            body: { sub_issue_id: remote.id },
          });
      }
      for (const key of ["children", "blockedBy"]) {
        for (const ref of base[key])
          if (!desired[key].some((x: any) => x.id === ref.id))
            actions.push(
              key === "children"
                ? {
                    method: "DELETE",
                    path: `${path}/sub_issue`,
                    body: { sub_issue_id: ref.id },
                  }
                : {
                    method: "DELETE",
                    path: `${path}/dependencies/blocked_by/${ref.id}`,
                  },
            );
        for (const ref of desired[key])
          if (!base[key].some((x: any) => x.id === ref.id))
            actions.push(
              key === "children"
                ? {
                    method: "POST",
                    path: `${path}/sub_issues`,
                    body: { sub_issue_id: ref.id },
                  }
                : {
                    method: "POST",
                    path: `${path}/dependencies/blocked_by`,
                    body: { issue_id: ref.id },
                  },
            );
      }
      if (
        !equal(
          base.children.map((x: any) => x.id),
          desired.children.map((x: any) => x.id),
        )
      )
        for (let i = 1; i < desired.children.length; i++)
          actions.push({
            method: "PATCH",
            path: `${path}/sub_issues/priority`,
            body: {
              sub_issue_id: desired.children[i].id,
              after_id: desired.children[i - 1].id,
            },
          });
    }
    result.push({ id, resource: name, actions });
    if (dry) continue;
    for (const action of actions) {
      await mutation(root, id, api, action.method, action.path, action.body);
      // 部分成功の時点ごとに基点を記録し、成功済み操作を繰り返さない。
      base =
        name === "relations"
          ? await fetchRelations(api, path)
          : normalizeFields(await api.list(`${path}/issue-field-values`));
      write(root, `${syncDir(id)}/remote/${name}.json`, base);
      settle(root, id);
    }
    if (!equal(base, desired)) {
      write(root, `${syncDir(id)}/conflicts/${name}.json`, [
        {
          base: read(root, `${syncDir(id)}/base/${name}.json`),
          local: desired,
          remote: base,
        },
      ]);
      throw new Error(`${name}: 反映結果が一致しません。変更を保持しました`);
    }
    write(root, `${syncDir(id)}/base/${name}.json`, base);
  }
}

async function reconcileResource(
  root: string,
  api: Api,
  op: any,
): Promise<void> {
  const field = op.path.match(
    /^(.*\/issues\/\d+)\/issue-field-values(?:\/(\d+))?$/,
  );
  let verified = false;
  if (field) {
    const values = normalizeFields(
      await api.list(`${field[1]}/issue-field-values`),
    ).values;
    verified =
      op.method === "DELETE"
        ? !values.some((x: any) => x.fieldId === Number(field[2]))
        : op.body.issue_field_values.every((f: any) =>
            values.some(
              (x: any) => x.fieldId === f.field_id && equal(x.value, f.value),
            ),
          );
  }
  const child = op.path.match(
    /^(.*\/issues\/\d+)\/sub_issue(?:s(?:\/priority)?)?$/,
  );
  if (child) {
    const children = await api.list(`${child[1]}/sub_issues`),
      ids = children.map((x) => x.id),
      index = ids.indexOf(op.body.sub_issue_id);
    verified =
      op.method === "DELETE"
        ? index < 0
        : op.method === "POST"
          ? index >= 0
          : op.body.after_id
            ? index === ids.indexOf(op.body.after_id) + 1
            : index + 1 === ids.indexOf(op.body.before_id);
  }
  const dependency = op.path.match(
    /^(.*\/issues\/\d+)\/dependencies\/blocked_by(?:\/(\d+))?$/,
  );
  if (dependency) {
    const values = await api.list(`${dependency[1]}/dependencies/blocked_by`);
    verified =
      op.method === "DELETE"
        ? !values.some((x) => x.id === Number(dependency[2]))
        : values.some((x) => x.id === op.body.issue_id);
  }
  if (!verified)
    throw new Error(
      "操作の成立をリモートで確認できません。結果確認待ちを保持します",
    );
  // 基点は進めず、最新状態を保存する。残りの差分は三者比較/明示解決で確定する。
  const remote = read<Remote>(root, `${issuePath(op.issueId)}/remote.json`),
    path = `${endpoint(config(root))}/issues/${remote.number}`;
  const resource = field ? "fields" : "relations";
  const current = field
    ? normalizeFields(await api.list(`${path}/issue-field-values`))
    : await fetchRelations(api, path);
  resourceMerge(root, op.issueId, resource, current);
}

function resourceRevision(root: string, id: string): string {
  return hash({
    relations: read(root, `${issuePath(id)}/relations.json`, null),
    fields: read(root, `${issuePath(id)}/fields.json`, null),
    comments: comments(root, id).map((c) => ({ id: c.id, body: c.body })),
  });
}
function itemRevision(root: string, id: string): string {
  return hash({
    document: document(root, id),
    resources: resourceRevision(root, id),
  });
}
export function localRevision(root: string): string {
  return hash(ids(root).map((id) => [id, itemRevision(root, id)]));
}
export function resolveComment(
  root: string,
  id: string,
  commentId: string,
  choice: string,
): void {
  issuePath(commentId);
  if (!["local", "remote"].includes(choice))
    throw new Error("--take local|remote を指定してください");
  const remote = read<any>(
    root,
    `${syncDir(id)}/remote/comments/${commentId}.json`,
  );
  const changes: Record<string, string> = {
    [`${syncDir(id)}/base/comments/${commentId}.json`]: JSON.stringify(remote),
    [`${syncDir(id)}/conflicts/comment-${commentId}.json`]: "[]",
  };
  if (choice === "remote")
    changes[`${issuePath(id)}/comments/${commentId}/index.md`] = remote.body;
  writeBatch(root, changes);
}
