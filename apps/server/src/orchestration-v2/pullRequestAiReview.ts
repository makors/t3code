import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestAiReview,
  ThreadPullRequestAiReviewer,
} from "@t3tools/contracts";

/**
 * A bot that posts an "in progress" comment and never edits it would read as reviewing forever,
 * so that signal only holds this long.
 */
export const AI_REVIEW_IN_PROGRESS_LIMIT_MS = 30 * 60_000;

interface AiReviewerDefinition {
  readonly name: string;
  /** Lowercase, without the `[bot]` suffix: GraphQL reads drop it and REST reads keep it. */
  readonly logins: ReadonlyArray<string>;
  readonly check: RegExp | null;
}

const BUILT_IN_REVIEWERS: ReadonlyArray<AiReviewerDefinition> = [
  { name: "CodeRabbit", logins: ["coderabbitai"], check: /^coderabbit/i },
  {
    name: "Greptile",
    logins: ["greptile-apps", "greptile-apps-staging"],
    check: /^greptile/i,
  },
  { name: "Copilot", logins: ["copilot-pull-request-reviewer", "copilot"], check: null },
  { name: "Cursor Bugbot", logins: ["cursor"], check: /bugbot/i },
  { name: "Graphite", logins: ["graphite-app"], check: /^graphite\b.*\b(ai|review|diamond)/i },
  { name: "Gemini", logins: ["gemini-code-assist"], check: null },
  { name: "Claude", logins: ["claude"], check: /^claude[- ]?(code[- ]?)?review/i },
  { name: "Codex", logins: ["chatgpt-codex-connector"], check: null },
  { name: "Sourcery", logins: ["sourcery-ai"], check: /^sourcery/i },
  { name: "Qodo", logins: ["qodo-merge-pro", "qodo-merge", "qodo-code-review"], check: null },
  { name: "Ellipsis", logins: ["ellipsis-dev"], check: /^ellipsis/i },
  { name: "Korbit", logins: ["korbit-ai"], check: null },
];

// Phrases review bots put in a placeholder comment they later edit into the review.
const IN_PROGRESS_MARKER =
  /review in progress|currently processing|reviewing (?:your|the|this) (?:pr|pull request|changes)|review (?:is )?(?:queued|started|pending)/i;

const normalizeLogin = (login: string) =>
  login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/u, "");

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A custom entry names a bot login, a check name prefix, or both at once. */
function customReviewer(entry: string): AiReviewerDefinition {
  return {
    name: entry.trim(),
    logins: [normalizeLogin(entry)],
    check: new RegExp(`^${escapeRegExp(entry.trim())}`, "i"),
  };
}

export function aiReviewerDefinitions(
  custom: ReadonlyArray<string>,
): ReadonlyArray<AiReviewerDefinition> {
  const known = new Set(BUILT_IN_REVIEWERS.flatMap((reviewer) => reviewer.logins));
  return [
    ...BUILT_IN_REVIEWERS,
    ...custom.filter((entry) => !known.has(normalizeLogin(entry))).map(customReviewer),
  ];
}

type AiReviewComment = Pick<PullRequestComment, "author" | "body" | "createdAt" | "editedAt">;

export interface AiReviewInput {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Reviewers still requested on the pull request; a host drops one once it has reviewed. */
  readonly requestedReviewers: ReadonlyArray<PullRequestActor>;
  readonly comments: ReadonlyArray<AiReviewComment>;
  readonly customReviewers: ReadonlyArray<string>;
  readonly now: number;
}

/**
 * Each reviewer falls back through the signals it can give, strongest first: its check on the
 * head commit, a pending review request, then its latest comment. Bots differ in which of these
 * they post, and a read can miss any one of them.
 */
function resolveReviewer(
  reviewer: AiReviewerDefinition,
  input: AiReviewInput,
): ThreadPullRequestAiReviewer | null {
  const checks =
    reviewer.check === null ? [] : input.checks.filter((check) => reviewer.check!.test(check.name));
  if (checks.length > 0) {
    const pending = checks.some(
      (check) => check.status === "pending" || check.status === "action-required",
    );
    return { name: reviewer.name, state: pending ? "reviewing" : "reviewed" };
  }

  const isReviewer = (actor: PullRequestActor | null | undefined) =>
    actor != null && reviewer.logins.includes(normalizeLogin(actor.login));

  if (input.requestedReviewers.some(isReviewer)) {
    return { name: reviewer.name, state: "reviewing" };
  }

  let latest: AiReviewComment | null = null;
  for (const comment of input.comments) {
    if (!isReviewer(comment.author)) continue;
    const at = comment.editedAt ?? comment.createdAt;
    if (latest === null || at > (latest.editedAt ?? latest.createdAt)) latest = comment;
  }
  if (latest === null) return null;
  const activeAt = Date.parse(latest.editedAt ?? latest.createdAt);
  const inProgress =
    IN_PROGRESS_MARKER.test(latest.body) && input.now - activeAt < AI_REVIEW_IN_PROGRESS_LIMIT_MS;
  return { name: reviewer.name, state: inProgress ? "reviewing" : "reviewed" };
}

export function resolveAiReview(input: AiReviewInput): ThreadPullRequestAiReview | undefined {
  const reviewers = aiReviewerDefinitions(input.customReviewers).flatMap((reviewer) => {
    const resolved = resolveReviewer(reviewer, input);
    return resolved === null ? [] : [resolved];
  });
  if (reviewers.length === 0) return undefined;
  return {
    state: reviewers.some((reviewer) => reviewer.state === "reviewing") ? "reviewing" : "reviewed",
    reviewers,
  };
}

export function aiReviewsEqual(
  left: ThreadPullRequestAiReview | undefined,
  right: ThreadPullRequestAiReview | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.state === right.state &&
    left.reviewers.length === right.reviewers.length &&
    left.reviewers.every(
      (reviewer, index) =>
        reviewer.name === right.reviewers[index]!.name &&
        reviewer.state === right.reviewers[index]!.state,
    )
  );
}
