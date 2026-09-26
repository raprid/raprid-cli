// 終了コード: 0 成功 / 1 操作の失敗 / 2 引数の誤り
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
  }
}
