import { isKind, type MemoryKind, type MemoryType } from "../types.js";

/**
 * Kind classification (ADR-0021).
 *
 * `type` answers "what shape is this" (a fact, an event, a procedure). In a
 * repository that runs for months, the question that decides retention is a
 * different one: *why does this deserve to survive?* A decision, a convention and
 * a gotcha are the three things that cost real time to rediscover, so they are
 * durable by contract. A task is true for a week. A note is true until someone
 * reads it.
 *
 * Derivation is lexical and ordered — zero model calls, same reasoning as the
 * write-time gate (ADR-0002, ADR-0015). An explicit kind always wins, because the
 * caller (an MCP tool that means "record a decision") knows better than a regex.
 */

export const DAY_MS = 86_400_000;

/**
 * How long a kind survives without being read (ADR-0021). `null` = durable:
 * decay never archives it, because losing it silently charges the next session
 * the same discovery cost.
 */
export const KIND_RETENTION_MS: Record<MemoryKind, number | null> = {
  decision: null,
  convention: null,
  gotcha: null,
  fact: 90 * DAY_MS,
  note: 30 * DAY_MS,
  task: 7 * DAY_MS
};

export function isDurableKind(kind: MemoryKind): boolean {
  return KIND_RETENTION_MS[kind] === null;
}

/** Importance a kind earns when the caller names it but gives no number. */
export const KIND_IMPORTANCE: Record<MemoryKind, number> = {
  decision: 0.8,
  convention: 0.75,
  gotcha: 0.75,
  fact: 0.6,
  task: 0.5,
  note: 0.4
};

/**
 * Type a kind implies, used only when a caller names the kind and not the type.
 * A convention is how-to knowledge; a task is working memory; a decision is a
 * fact about the project that outlives the conversation that made it.
 */
export const KIND_TYPE: Record<MemoryKind, MemoryType> = {
  decision: "semantic",
  convention: "procedural",
  gotcha: "procedural",
  fact: "semantic",
  task: "working",
  note: "episodic"
};

// Ordered rules, first match wins. English and Chinese: 60% of this store is
// Chinese, and a classifier that only reads English would label every Chinese
// decision a `note` and archive it.
const RULES: { kind: MemoryKind; pattern: RegExp }[] = [
  {
    kind: "decision",
    pattern:
      /\b(we (decided|chose|settled on|agreed|picked)|decision:|decided to|chose .{1,40} over|going with|settled on|we(?:'| a)re using)\b|(?:决定|定了|敲定|选(?:用|了)|定为|结论)[:：]?/i
  },
  {
    kind: "gotcha",
    pattern:
      /\b(gotcha|watch out|caution|bites|bit us|broke because|breaks? (?:when|if|because)|fails? (?:when|if|because)|does(?:n't| not) work|crash(?:es|ed)? (?:when|if)|deadlock|race condition|EPERM|EACCES|ENOSPC|regression|silently)\b|(?:踩坑|坑点|坑了|会崩|会挂|会报错|要注意|注意[:：]|导致失败|不生效)/i
  },
  {
    kind: "convention",
    pattern:
      /\b(always|never|must|should always|should never|convention|house style|prefer|avoid|don't|do not|use .{1,30} instead|instead of)\b|(?:一律|总是|永远|必须|务必|禁止|不要|别用|约定|规范|偏好)/i
  },
  {
    kind: "task",
    pattern:
      /\b(todo|to-do|next step|next up|in progress|wip|blocked on|waiting on|still need|remaining|left off|picking (?:this )?back up)\b|(?:待办|下一步|进行中|阻塞|剩余|还没做|接着做|未完成)/i
  },
  {
    kind: "fact",
    pattern:
      /\b(is|are|was|were|uses|use|has|have|lives|works at|costs|runs on|depends on)\b|(?:是|在|用|有|属于|位于|使用|版本)/i
  }
];

export interface DeriveKindOptions {
  /** Caller's kind. Wins over the text. */
  explicit?: string | null;
  /** Type already decided by the caller; only used as a last tie-break. */
  type?: MemoryType;
}

/**
 * Classify one memory's text. `note` is the honest fallback: something was kept
 * that does not advertise why, and the 30-day retention treats it accordingly
 * instead of guessing durability it has not earned.
 */
export function deriveKind(text: string, opts: DeriveKindOptions = {}): MemoryKind {
  const explicit = opts.explicit;
  if (isKind(explicit)) return explicit;
  const body = String(text ?? "");
  for (const rule of RULES) {
    if (rule.pattern.test(body)) return rule.kind;
  }
  return "note";
}

/** Human label used by the brief and the console. */
export const KIND_LABELS: Record<MemoryKind, string> = {
  decision: "decision",
  convention: "convention",
  gotcha: "gotcha",
  fact: "fact",
  task: "open",
  note: "note"
};
