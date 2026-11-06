import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./tui-fixtures.ts";
const { slackToken, slackDefaultChannel, slackDefaultWorkspace } = await load<typeof import("../src/workspace/slack-auth.js")>("../dist/workspace/slack-auth.js");

test("Slack トークンは環境変数を優先し、設定値をエラーに含めない", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-slack-auth-"));
  try {
    writeFileSync(join(root, ".env"), "SLACK_USER_OAUTH_TOKEN=xoxp-file-token\nSLACK_CHANNEL_ID=C123\nSLACK_WORKSPACE_ID=T123\n");
    assert.equal(slackToken(root, {}), "xoxp-file-token");
    assert.equal(slackToken(root, { SLACK_USER_OAUTH_TOKEN: "xoxp-env-token" }), "xoxp-env-token");
    assert.equal(slackDefaultChannel(root, {}), "C123");
    assert.equal(slackDefaultChannel(root, { SLACK_CHANNEL_ID: "C456" }), "C456");
    assert.equal(slackDefaultWorkspace(root, {}), "T123");
    assert.equal(slackDefaultWorkspace(root, { SLACK_WORKSPACE_ID: "T456" }), "T456");
    assert.throws(() => slackToken(root, { SLACK_USER_OAUTH_TOKEN: "secret-value" }), (error: Error) => !error.message.includes("secret-value"));
    assert.throws(() => slackToken(root, { SLACK_USER_OAUTH_TOKEN: "" }), /設定してください/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
