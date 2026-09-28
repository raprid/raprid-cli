// 終了コード: 0 成功 / 1 操作の失敗 / 2 引数の誤り
// code は --json のエラー応答 ({ schemaVersion, error: { code, message } }) に使う
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(message: string, exitCode = 1, code?: string) {
    super(message);
    this.exitCode = exitCode;
    this.code = code ?? (exitCode === 2 ? "USAGE" : "FAILED");
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2, "USAGE");
  }
}
