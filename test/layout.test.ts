import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, renameSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./tui-fixtures.ts";
const { initialize, add, document, read, write } = await load<typeof import("../src/workspace/store.js")>("../dist/workspace/store.js");
const { migrateLayout } = await load<typeof import("../src/workspace/layout.js")>("../dist/workspace/layout.js");
function legacy(root: string) {
 initialize(root, "a/b");
 const id = add(root, "未送信", "編集内容");
 renameSync(join(root,"github/issues"),join(root,"issues"));
 renameSync(join(root,"github/wiki"),join(root,"wiki"));
 rmSync(join(root,"github"),{recursive:true});
 const c: any = read(root,".raprid/config.json"); delete c.layout; write(root,".raprid/config.json",c);
 writeFileSync(join(root,"wiki/Page.md"),"Wiki 原稿");
 return id;
}
test("v2 の未送信 Issue と Wiki を安全に移す", () => {
 const root=mkdtempSync(join(tmpdir(),"raprid-layout-"));
 try { const id=legacy(root); migrateLayout(root,false); assert.equal(existsSync(join(root,"github")),false);
 migrateLayout(root,true); assert.equal(document(root,id).body,"編集内容"); assert.equal(readFileSync(join(root,"github/wiki/Page.md"),"utf8"),"Wiki 原稿");
 assert.ok("alreadyMigrated" in migrateLayout(root,true));
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test("移行先の衝突を拒否し、中断後に再開できる", () => {
 const root=mkdtempSync(join(tmpdir(),"raprid-layout-"));
 try { const id=legacy(root); mkdirSync(join(root,"github")); assert.throws(()=>migrateLayout(root,true),/既に存在/); rmSync(join(root,"github"),{recursive:true});
 write(root,".raprid/layout-migration.json",{version:1}); mkdirSync(join(root,"github")); renameSync(join(root,"issues"),join(root,"github/issues"));
 migrateLayout(root,true); assert.equal(document(root,id).body,"編集内容");
 } finally {rmSync(root,{recursive:true,force:true});}
});
