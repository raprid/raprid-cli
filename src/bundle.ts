// dist/template.json の形式。npm pack はシンボリックリンクや .gitignore を保てないため、
// template/ の内容を種別・権限ごと 1 つの JSON にまとめて配布する。

export interface TemplateSource {
  repository: string;
  ref: string;
  commit: string;
}

export type TemplateEntry =
  | { type: "file"; path: string; mode: number; content: string } // content は base64
  | { type: "symlink"; path: string; target: string };

export interface TemplateBundle {
  format: 1;
  source: TemplateSource;
  entries: TemplateEntry[];
}
