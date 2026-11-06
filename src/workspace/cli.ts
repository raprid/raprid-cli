import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  add,
  config,
  document,
  findRoot,
  initialize,
  issuePath,
  locked,
  read,
  safe,
  saveDocument,
  select,
  write,
} from "./store.js";
import { GitHub } from "./github.js";
import {
  addComment,
  pull,
  push,
  reconcile,
  resolveConflict,
  resolveComment,
  status,
} from "./sync.js";
import { git, wiki } from "./wiki.js";
import { migrate } from "./migrate.js";
import { help } from "./help.js";
export { help };
export async function run(argv: string[]): Promise<number> {
  try {
    const { values: v, positionals: p } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        host: { type: "string" },
        "dry-run": { type: "boolean" },
        "no-git": { type: "boolean" },
        json: { type: "boolean" },
        "body-file": { type: "string" },
        metadata: { type: "boolean" },
        comment: { type: "string" },
        resource: { type: "string" },
        reason: { type: "string" },
        take: { type: "string" },
        "remote-id": { type: "string" },
        message: { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (v.help) {
      console.log(help);
      return 0;
    }
    const [group, action, selector] = p;
    let result: any;
    if (group === "init") {
      const root = resolve(action ?? ".");
      initialize(root, v.repo ?? "", v.host ?? "github.com", v["dry-run"]);
      if (!v["dry-run"] && !v["no-git"]) git(root, ["init"]);
      result = { root, dryRun: !!v["dry-run"] };
    } else if (group === "migrate") {
      if (!action || !selector)
        throw new Error("移行元・移行先を指定してください");
      result = migrate(action, selector, v.repo ?? "", !!v.apply);
    } else {
      const root = findRoot();
      if (group === "issue" && action === "edit") {
        const id = select(root, selector ?? ""),
          file = safe(
            root,
            `${issuePath(id)}/${v.metadata ? "issue.json" : "index.md"}`,
          ),
          editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
        // shellを使わず、EDITORは実行ファイル名として扱う。
        const r = spawnSync(editor, [file], { stdio: "inherit" });
        if (r.error || r.status !== 0)
          throw new Error("エディタの実行に失敗しました");
        document(root, id);
        result = { id };
      } else
        result = await locked(root, async () => {
          if (group === "issue") {
            if (action === "list") return status(root);
            if (action === "create")
              return {
                id: add(
                  root,
                  p.slice(2).join(" "),
                  v["body-file"] ? readFileSync(v["body-file"], "utf8") : "",
                ),
              };
            const id = select(root, selector ?? "");
            if (action === "show")
              return {
                id,
                ...document(root, id),
                remote: read(root, `${issuePath(id)}/remote.json`, null),
              };
            if (action === "comment") {
              if (!v["body-file"]) throw new Error("--body-fileが必要です");
              return {
                commentId: addComment(
                  root,
                  id,
                  readFileSync(v["body-file"], "utf8"),
                ),
              };
            }
            if (action === "close" || action === "reopen") {
              const doc = document(root, id);
              doc.issue.state = action === "close" ? "closed" : "open";
              doc.issue.stateReason =
                action === "close" ? (v.reason ?? "completed") : "reopened";
              saveDocument(root, id, doc);
              return { id, ...doc };
            }
          } else if (group === "sync") {
            if (action === "status") return status(root);
            if (action === "resolve" && v.comment) {
              resolveComment(
                root,
                select(root, selector ?? ""),
                v.comment,
                v.take ?? "",
              );
              return { resolved: v.comment };
            }
            if (action === "resolve") {
              resolveConflict(
                root,
                select(root, selector ?? ""),
                v.take ?? "",
                v.resource,
              );
              return { resolved: selector };
            }
            const api = new GitHub(config(root));
            if (action === "pull") return pull(root, api);
            if (action === "push") return push(root, api, !!v["dry-run"]);
            if (action === "reconcile")
              return reconcile(
                root,
                api,
                selector ?? "",
                v["remote-id"] ? Number(v["remote-id"]) : undefined,
              );
          } else if (group === "wiki")
            return wiki(root, action, !!v["dry-run"], v.message);
          throw new Error("不明な操作です。raprid --helpを参照してください");
        });
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
