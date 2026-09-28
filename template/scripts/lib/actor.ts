import { UsageError } from "./errors.ts";

const actorPattern = /^(human|agent)\/[a-z0-9][a-z0-9._-]*$/;

export function actor(value: string | undefined, option: string): string {
  if (!value || !actorPattern.test(value)) {
    throw new UsageError(`${option}はhuman/<識別子>またはagent/<識別子>で指定してください: ${value ?? ""}`);
  }
  return value;
}

export function actorLabel(value: string): string {
  return value || "legacy/unknown";
}
