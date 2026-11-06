import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { load } from "./tui-fixtures.ts";
const {
  initialize,
  add,
  document,
  saveDocument,
  read,
  write,
  ids,
  config,
  locked,
  safe,
} = await load<typeof import("../src/workspace/store.js")>(
  "../dist/workspace/store.js",
);
import type { Api } from "../src/workspace/github.js";
const { ApiError, GitHub } = await load<
  typeof import("../src/workspace/github.js")
>("../dist/workspace/github.js");
const {
  pull,
  push,
  status,
  merge,
  pendingOperations,
  reconcile,
  addComment,
  resolveConflict,
} = await load<typeof import("../src/workspace/sync.js")>(
  "../dist/workspace/sync.js",
);
const { migrate } = await load<typeof import("../src/workspace/migrate.js")>(
  "../dist/workspace/migrate.js",
);
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-v2-"));
  initialize(root, "test/repo");
  return root;
};
const raw = (n: number, title = "題名") => ({
  id: n + 100,
  number: n,
  node_id: `I_${n}`,
  title,
  body: "本文",
  state: "open",
  state_reason: null,
  labels: [],
  assignees: [],
  milestone: null,
  html_url: `https://github.com/test/repo/issues/${n}`,
});
class Fake implements Api {
  issues: any[] = [raw(1)];
  notes: any[] = [];
  calls: any[] = [];
  failCreate = false;
  denyLabels = false;
  async list(path: string): Promise<any[]> {
    if (path.includes("/comments")) return structuredClone(this.notes);
    if (path.includes("/sub_issues") || path.includes("/dependencies/"))
      return [];
    if (path.includes("/issue-field-values"))
      throw new ApiError(404, "利用不可");
    if (path.includes("/issues?")) return structuredClone(this.issues);
    return [];
  }
  async request(method: string, path: string, body?: any): Promise<any> {
    this.calls.push({ method, path, body });
    if (path.endsWith("/parent")) throw new ApiError(404, "親なし");
    if (path.includes("/issues/comments/"))
      return structuredClone(
        this.notes.find((x) => x.id === Number(path.split("/").at(-1))),
      );
    if (path.endsWith("/comments") && method === "POST") {
      const c = { id: 201, body: body.body, user: { login: "tester" } };
      this.notes.push(c);
      return c;
    }
    if (method === "POST" && path.endsWith("/issues")) {
      const item = {
        ...raw(this.issues.length + 1),
        ...body,
        state_reason: body.state_reason ?? null,
      };
      this.issues.push(item);
      if (this.failCreate) throw new Error("通信断");
      return structuredClone(item);
    }
    const item = this.issues.find(
      (x) => x.number === Number(path.split("/").at(-1)),
    );
    if (!item) throw new ApiError(404, "not found");
    if (method === "PATCH")
      for (const [k, v] of Object.entries(body)) {
        if (k === "labels") {
          if (!this.denyLabels)
            item.labels = (v as string[]).map((name) => ({ name }));
        } else if (k === "assignees")
          item.assignees = (v as string[]).map((login) => ({ login }));
        else if (k === "milestone")
          item.milestone = v === null ? null : { number: v };
        else item[k] = v;
      }
    return structuredClone(item);
  }
}
test("初期化は既存パスを上書きせず、dry-runは書き込まない", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-init-"));
  initialize(root, "test/repo", "github.com", true);
  assert.deepEqual(readdirSync(root), []);
  writeFileSync(join(root, "README.md"), "既存");
  assert.throws(() => initialize(root, "test/repo"));
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "既存");
  assert.equal(existsSync(join(root, ".raprid")), false);
});
test("リンクによるワークスペース外書き込みを拒否", () => {
  const root = fixture(),
    outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(root, "issues", "evil"));
  assert.throws(() => write(root, "issues/evil/issue.json", {}));
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => safe(root, "../bad"));
});
test("ロックは同時更新を拒否して例外後に解除", async () => {
  const root = fixture();
  await locked(root, async () => {
    await assert.rejects(locked(root, () => {}));
  });
  await assert.rejects(
    locked(root, () => {
      throw new Error("失敗");
    }),
  );
  await locked(root, () => {});
});
test("pullはPRを除き、未取得属性の空ファイルを生成しない", async () => {
  const root = fixture(),
    api = new Fake();
  api.issues.push({ ...raw(2), pull_request: {} });
  await pull(root, api);
  assert.equal(ids(root).length, 1);
  const id = ids(root)[0];
  assert.equal(document(root, id).body, "本文");
  assert.equal(existsSync(join(root, "issues", id, "fields.json")), false);
  assert.equal(status(root).issues[0].fetched.fields.status, "unavailable");
});
test("別項目の変更は統合し、同じ本文の競合は保持して送信しない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.body = "手元";
  saveDocument(root, id, doc);
  api.issues[0].title = "リモート";
  await pull(root, api);
  assert.equal(document(root, id).issue.title, "リモート");
  assert.equal(document(root, id).body, "手元");
  api.issues[0].body = "相手";
  await pull(root, api);
  assert.equal(status(root).issues[0].conflicts, 1);
  await assert.rejects(push(root, api));
  assert.equal(api.calls.filter((x) => x.method === "PATCH").length, 0);
  resolveConflict(root, id, "local");
  await push(root, api);
  assert.equal(api.issues[0].body, "手元");
});
test("双方のラベル追加を保持", () => {
  assert.deepEqual(
    merge({ labels: ["a"] }, { labels: ["a", "b"] }, { labels: ["a", "c"] })
      .value.labels,
    ["a", "b", "c"],
  );
});
test("dry-runはローカルもリモートも変更しない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.body = "変更";
  saveDocument(root, id, doc);
  const before = JSON.stringify(status(root));
  api.issues[0].title = "更新";
  const plan = await push(root, api, true);
  assert.equal(plan.length, 1);
  assert.equal(JSON.stringify(status(root)), before);
  assert.equal(
    api.calls.some((x) => x.method === "PATCH"),
    false,
  );
});
test("作成成功後の通信断は二重作成せず、明示照合で復旧", async () => {
  const root = fixture(),
    api = new Fake();
  const id = add(root, "新規", "本文");
  api.failCreate = true;
  await assert.rejects(push(root, api));
  assert.equal(api.issues.length, 2);
  assert.equal(pendingOperations(root).length, 1);
  await assert.rejects(push(root, api));
  assert.equal(api.issues.length, 2);
  const op = pendingOperations(root)[0];
  await reconcile(root, api, op.id, 2);
  assert.equal(pendingOperations(root).length, 0);
  assert.equal(read<any>(root, `issues/${id}/remote.json`).number, 2);
  await push(root, api);
  assert.equal(api.issues.length, 2);
});
test("権限により属性が無視された場合は差分を残す", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.issue.labels = ["bug"];
  saveDocument(root, id, doc);
  api.denyLabels = true;
  await assert.rejects(push(root, api), /一致しません/);
  assert.equal(status(root).issues[0].dirty, true);
  assert.equal(pendingOperations(root).length, 0);
});
test("コメントを個別送信し再送しない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  addComment(root, ids(root)[0], "回答");
  await push(root, api);
  await push(root, api);
  assert.equal(api.notes.length, 1);
  assert.equal(status(root).issues[0].dirty, false);
});
test("未取得のfieldsを直接作っても解除・送信しない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  write(root, `issues/${ids(root)[0]}/fields.json`, {
    schemaVersion: 1,
    values: [],
  });
  await assert.rejects(push(root, api), /先にpull/);
  assert.equal(
    api.calls.some((x) => x.method === "PUT"),
    false,
  );
});
test("HTTP APIはページングし、他ホストの次ページを拒否する", async () => {
  let hostile = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.setHeader("content-type", "application/json");
    if (!req.url?.includes("page=2"))
      res.setHeader(
        "link",
        `<${hostile ? "https://other.invalid" : `http://127.0.0.1:${(server.address() as any).port}`}/items?page=2>; rel="next"`,
      );
    res.end(JSON.stringify([req.url]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = new GitHub(config(fixture()), {
      base: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "fixture-token",
    });
    assert.equal((await api.list("items")).length, 2);
    hostile = true;
    await assert.rejects(api.list("items"), /別ホスト/);
  } finally {
    server.close();
  }
});

test("結果不明の新規Issueはpullで別IDに取り込まない", async () => {
  const root = fixture(),
    api = new Fake();
  add(root, "新規", "本文");
  api.failCreate = true;
  await assert.rejects(push(root, api));
  await pull(root, api);
  assert.equal(ids(root).length, 1);
  await reconcile(root, api, pendingOperations(root)[0].id, 2);
  await pull(root, api);
  assert.equal(ids(root).length, 2);
});
test("GET中の直接編集を保持し古い本文を送らない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.body = "送信前";
  saveDocument(root, id, doc);
  const request = api.request.bind(api);
  let changed = false;
  api.request = async (m, p, b) => {
    if (m === "GET" && p.endsWith("/issues/1") && !changed) {
      changed = true;
      const latest = document(root, id);
      latest.body = "編集中";
      saveDocument(root, id, latest);
    }
    return request(m, p, b);
  };
  await assert.rejects(push(root, api), /ローカル内容/);
  assert.equal(document(root, id).body, "編集中");
  assert.equal(api.issues[0].body, "本文");
});
test("PATCHの結果不明を照合すると無関係なリモート更新を取り込む", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.body = "変更";
  saveDocument(root, id, doc);
  const request = api.request.bind(api);
  api.request = async (m, p, b) => {
    const result = await request(m, p, b);
    if (m === "PATCH") throw new Error("応答断");
    return result;
  };
  await assert.rejects(push(root, api));
  api.issues[0].title = "他者のタイトル";
  await reconcile(root, api, pendingOperations(root)[0].id);
  assert.equal(document(root, id).issue.title, "他者のタイトル");
  api.request = request;
  await push(root, api);
  assert.equal(api.issues[0].title, "他者のタイトル");
});
test("差分のないduplicateのIssueが他の送信を妨げない", async () => {
  const root = fixture(),
    api = new Fake();
  api.issues[0].state = "closed";
  api.issues[0].state_reason = "duplicate";
  await pull(root, api);
  add(root, "新規", "本文");
  await push(root, api);
  assert.equal(api.issues.length, 2);
});
test("新規Issueのdry-runにコメントも含める", async () => {
  const root = fixture(),
    api = new Fake();
  const id = add(root, "新規", "本文");
  addComment(root, id, "補足");
  const plan = await push(root, api, true);
  assert.equal(
    plan.some((x) => x.action === "create-comment-after-issue"),
    true,
  );
  assert.equal(api.notes.length, 0);
});
test("コメントの結果不明は編集後もIDで照合し、別Issueは拒否", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    cid = addComment(root, id, "送信内容");
  const request = api.request.bind(api);
  api.request = async (m, p, b) => {
    const result = await request(m, p, b);
    if (m === "POST" && p.endsWith("/comments")) throw new Error("応答断");
    return result;
  };
  await assert.rejects(push(root, api));
  writeFileSync(
    join(root, `issues/${id}/comments/${cid}/index.md`),
    "送信後の編集",
  );
  api.notes[0].issue_url = "https://api.github.com/repos/test/repo/issues/9";
  const op = pendingOperations(root)[0];
  await assert.rejects(reconcile(root, api, op.id, 201), /別のIssue/);
  api.notes[0].issue_url = "https://api.github.com/repos/test/repo/issues/1";
  await reconcile(root, api, op.id, 201);
  assert.equal(
    readFileSync(join(root, `issues/${id}/comments/${cid}/index.md`), "utf8"),
    "送信後の編集",
  );
});

class ResourceFake extends Fake {
  fields: any[] = [{ issue_field_id: 1, data_type: "text", value: "旧" }];
  children: any[] = [];
  dependencies: any[] = [];
  failField = false;
  extraField = false;
  override async list(path: string): Promise<any[]> {
    if (path.includes("/issue-field-values"))
      return structuredClone(this.fields);
    if (path.endsWith("/sub_issues")) return structuredClone(this.children);
    if (path.endsWith("/dependencies/blocked_by"))
      return structuredClone(this.dependencies);
    return super.list(path);
  }
  override async request(
    method: string,
    path: string,
    body?: any,
  ): Promise<any> {
    if (method === "PUT" && path.endsWith("/issue-field-values")) {
      this.calls.push({ method, path, body });
      for (const f of body.issue_field_values) {
        this.fields = this.fields.filter(
          (x) => x.issue_field_id !== f.field_id,
        );
        this.fields.push({
          issue_field_id: f.field_id,
          data_type: "text",
          value: f.value,
        });
      }
      if (this.extraField)
        this.fields.push({
          issue_field_id: 99,
          data_type: "text",
          value: "他者の追加",
        });
      if (this.failField) throw new Error("通信断");
      return structuredClone(this.fields);
    }
    if (method === "DELETE" && path.includes("/issue-field-values/")) {
      this.calls.push({ method, path, body });
      this.fields = this.fields.filter(
        (x) => x.issue_field_id !== Number(path.split("/").at(-1)),
      );
      return null;
    }
    if (method === "POST" && path.endsWith("/sub_issues")) {
      this.calls.push({ method, path, body });
      this.children.push(raw(body.sub_issue_id - 100));
      return this.children;
    }
    if (method === "POST" && path.endsWith("/dependencies/blocked_by")) {
      this.calls.push({ method, path, body });
      this.dependencies.push(raw(body.issue_id - 100));
      return this.dependencies;
    }
    return super.request(method, path, body);
  }
}
test("Issue fieldsの変更と解除を専用APIへ送り照合する", async () => {
  const root = fixture(),
    api = new ResourceFake();
  await pull(root, api);
  const id = ids(root)[0];
  write(root, `issues/${id}/fields.json`, {
    schemaVersion: 1,
    values: [{ fieldId: 1, value: "新" }],
  });
  await push(root, api);
  assert.equal(api.fields[0].value, "新");
  write(root, `issues/${id}/fields.json`, { schemaVersion: 1, values: [] });
  await push(root, api);
  assert.deepEqual(api.fields, []);
});
test("field更新中の他者の追加を次pushで削除しない", async () => {
  const root = fixture(),
    api = new ResourceFake();
  await pull(root, api);
  const id = ids(root)[0];
  write(root, `issues/${id}/fields.json`, {
    schemaVersion: 1,
    values: [{ fieldId: 1, value: "新" }],
  });
  api.extraField = true;
  await assert.rejects(push(root, api), /一致しません/);
  await assert.rejects(push(root, api), /競合/);
  assert.equal(
    api.fields.some((x) => x.issue_field_id === 99),
    true,
  );
  assert.equal(
    api.calls.some((x) => x.method === "DELETE"),
    false,
  );
  resolveConflict(root, id, "remote", "fields");
  assert.equal(status(root).issues[0].dirty, false);
});
test("field更新の通信断をリモート照合で復旧", async () => {
  const root = fixture(),
    api = new ResourceFake();
  await pull(root, api);
  const id = ids(root)[0];
  write(root, `issues/${id}/fields.json`, {
    schemaVersion: 1,
    values: [{ fieldId: 1, value: "新" }],
  });
  api.failField = true;
  await assert.rejects(push(root, api));
  await reconcile(root, api, pendingOperations(root)[0].id);
  assert.equal(pendingOperations(root).length, 0);
  assert.equal(status(root).issues[0].dirty, false);
});
test("親子と依存関係を異なるAPIに送る", async () => {
  const root = fixture(),
    api = new ResourceFake();
  await pull(root, api);
  const id = ids(root)[0],
    ref = { id: 102, number: 2, url: "https://github.com/test/repo/issues/2" };
  write(root, `issues/${id}/relations.json`, {
    schemaVersion: 1,
    parent: null,
    children: [ref],
    blockedBy: [ref],
  });
  await push(root, api);
  assert.equal(api.children[0].id, 102);
  assert.equal(api.dependencies[0].id, 102);
});
test("中断した複数ファイル保存を再開し、外部編集がある場合は停止", async () => {
  const root = fixture(),
    id = add(root, "保存", "前");
  const path = `issues/${id}/index.md`;
  write(root, ".raprid/sync/writes/interrupted.json", [
    { path, before: "前", next: "後" },
  ]);
  await locked(root, () => {});
  assert.equal(document(root, id).body, "後");
  write(root, ".raprid/sync/writes/conflict.json", [
    { path, before: "前", next: "途中" },
  ]);
  await assert.rejects(
    locked(root, () => {}),
    /外部編集/,
  );
  assert.equal(document(root, id).body, "後");
});
test("v0.4.0移行は元ファイル・詳細・添付を保持し状態を自動承認しない", () => {
  const source = mkdtempSync(join(tmpdir(), "raprid-old-")),
    target = join(mkdtempSync(join(tmpdir(), "raprid-new-")), "workspace");
  write(source, "jobs/demo/tasks/task/data.json", { keep: true });
  const path = join(source, "jobs/demo/tasks/task/index.md");
  writeFileSync(
    path,
    "---\nid: T-001\nstatus: done\n---\n\n## タイトル\n\n旧タスク\n\n本文",
  );
  write(source, "docs/design/data.json", { example: true });
  const before = readFileSync(path, "utf8");
  const plan = migrate(source, target, "test/repo", false);
  assert.equal(plan.issues.length, 1);
  assert.equal(existsSync(target), false);
  const result = migrate(source, target, "test/repo", true);
  assert.equal(document(target, result.mappings[0].id).issue.state, "open");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(
    read<any>(target, "logs/migration/source/jobs/demo/tasks/task/data.json")
      .keep,
    true,
  );
});
test("Wikiは実Gitでcommit/pushでき、分岐を強制上書きしない", async () => {
  const { git, wiki } = await load<typeof import("../src/workspace/wiki.js")>(
    "../dist/workspace/wiki.js",
  );
  const root = fixture(),
    dir = mkdtempSync(join(tmpdir(), "wiki-remote-")),
    remote = join(dir, "remote.git");
  git(dir, ["init", "--bare", remote]);
  git(dir, ["clone", remote, join(dir, "seed")]);
  const seed = join(dir, "seed");
  git(seed, ["config", "user.name", "試験"]);
  git(seed, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(seed, "Home.md"), "初期");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "初期"]);
  git(seed, ["push", "origin", "HEAD"]);
  const transport = (cwd: string, args: string[]) => {
    if (args[0] === "clone") return git(cwd, ["clone", remote, args.at(-1)!]);
    if (args[0] === "remote" && args[1] === "get-url")
      return "git@github.com:test/repo.wiki.git";
    return git(cwd, args);
  };
  wiki(root, "pull", false, undefined, transport);
  const checkout = join(root, "wiki");
  git(checkout, ["config", "user.name", "試験"]);
  git(checkout, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(checkout, "Home.md"), "手元");
  assert.throws(
    () => wiki(root, "push", false, undefined, transport),
    /未コミット/,
  );
  wiki(root, "commit", false, "編集", transport);
  wiki(root, "push", false, undefined, transport);
  assert.equal(
    git(checkout, ["rev-parse", "HEAD"]),
    git(dir, ["--git-dir", remote, "rev-parse", "HEAD"]),
  );
  git(seed, ["pull"]);
  writeFileSync(join(seed, "Other.md"), "他者");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "他者"]);
  git(seed, ["push"]);
  writeFileSync(join(checkout, "Local.md"), "手元");
  wiki(root, "commit", false, "手元", transport);
  assert.throws(
    () => wiki(root, "push", false, undefined, transport),
    /Git操作/,
  );
  wiki(root, "pull", false, undefined, transport);
  wiki(root, "push", false, undefined, transport);
  assert.equal(readFileSync(join(checkout, "Other.md"), "utf8"), "他者");
});

test("PATCHの結果照合で別Issueへ付け替えない", async () => {
  const root = fixture(),
    api = new Fake();
  await pull(root, api);
  const id = ids(root)[0],
    doc = document(root, id);
  doc.body = "変更";
  saveDocument(root, id, doc);
  const request = api.request.bind(api);
  api.request = async (m, p, b) => {
    const r = await request(m, p, b);
    if (m === "PATCH") throw new Error("応答断");
    return r;
  };
  await assert.rejects(push(root, api));
  api.issues.push({ ...raw(9), body: "変更" });
  await assert.rejects(
    reconcile(root, api, pendingOperations(root)[0].id, 9),
    /照合先/,
  );
  assert.equal(read<any>(root, `issues/${id}/remote.json`).number, 1);
});
test("プレビュー後の新規編集は確認したrevisionでは送らない", async () => {
  const { localRevision } = await load<
    typeof import("../src/workspace/sync.js")
  >("../dist/workspace/sync.js");
  const root = fixture(),
    api = new Fake();
  add(root, "新規");
  const revision = localRevision(root);
  await push(root, api, true);
  add(root, "追加");
  await assert.rejects(push(root, api, false, revision), /プレビュー後/);
  assert.equal(api.issues.length, 1);
});
