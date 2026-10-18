import type { ThreadPullRequestAiReview, ThreadPullRequestAiReviewer } from "@t3tools/contracts";
import type { ProviderChangeRequestReviewSignals } from "@t3tools/source-control-core/server/PullRequestProvider";

type Signals = ProviderChangeRequestReviewSignals;
type Check = Signals["checks"][number];
type Comment = Signals["comments"][number];

/**
 * A progress comment or reaction carries no commit, and a bot that crashes mid-review never
 * finishes it, so it only counts as in progress this long.
 */
export const AI_REVIEW_IN_PROGRESS_LIMIT_MS = 30 * 60_000;

interface Progress {
  readonly state: "reviewing" | "reviewed";
  readonly at: string | null;
  readonly avatarUrl: string | null;
}

interface ReviewBot {
  readonly name: string;
  /** GraphQL logins, which are also the app slugs behind the bot's checks. */
  readonly logins: ReadonlyArray<string>;
  /** Documented names of the bot's review checks, for hosts that do not say which app posted one. */
  readonly checks: ReadonlyArray<string | RegExp>;
  /** A completed check that did not review, such as a rate limit. */
  readonly skippedCheck?: (check: Check) => boolean;
  /** A bot-specific signal for bots that report progress outside checks and reviews. */
  readonly progress?: (signals: Signals, now: number) => Progress | null;
}

const activeAt = (comment: Comment) => comment.editedAt ?? comment.createdAt;
const fresh = (at: string, now: number) => now - Date.parse(at) < AI_REVIEW_IN_PROGRESS_LIMIT_MS;

/** The latest comment by one of `logins` that contains `marker`. */
function latestComment(
  signals: Signals,
  logins: ReadonlyArray<string>,
  marker: (body: string) => boolean,
): Comment | null {
  let latest: Comment | null = null;
  for (const comment of signals.comments) {
    if (!logins.includes(comment.login) || !marker(comment.body)) continue;
    if (latest === null || activeAt(comment) > activeAt(latest)) latest = comment;
  }
  return latest;
}

const CODERABBIT = ["coderabbitai"];
const GREPTILE = ["greptile-apps", "greptile-apps-staging"];
const CODEX = ["chatgpt-codex-connector"];
const CLAUDE = ["claude"];
const QODO = ["qodo-merge-pro", "qodo-merge", "qodo-code-review"];

// Each entry follows the bot's documented signals; where a bot gives none for progress, it is
// only ever seen as reviewed.
const BUILT_IN_BOTS: ReadonlyArray<ReviewBot> = [
  {
    name: "CodeRabbit",
    logins: CODERABBIT,
    checks: ["CodeRabbit", "CodeRabbit Security"],
    // Its status turns "success" with "Review rate limited" or "Review paused" without reviewing.
    skippedCheck: (check) => /rate limited|paused|skipped/i.test(check.description ?? ""),
    // Repositories with progress checks and statuses off still get the summary comment's markers.
    progress: (signals, now) => {
      const comment = latestComment(signals, CODERABBIT, (body) =>
        body.includes("auto-generated comment: "),
      );
      if (comment === null) return null;
      const at = activeAt(comment);
      if (comment.body.includes("review in progress by coderabbit.ai -->")) {
        return fresh(at, now) ? { state: "reviewing", at, avatarUrl: comment.avatarUrl } : null;
      }
      return comment.body.includes("summarize by coderabbit.ai -->")
        ? { state: "reviewed", at, avatarUrl: comment.avatarUrl }
        : null;
    },
  },
  {
    name: "Greptile",
    logins: GREPTILE,
    checks: ["Greptile Review"],
    // Without its status check, Greptile marks the description 👀 while working, then 👍 or 😕.
    progress: (signals) => {
      const reacted = (content: string) =>
        signals.reactions.some(
          (group) =>
            group.content === content && group.logins.some((login) => GREPTILE.includes(login)),
        );
      if (reacted("thumbs_up") || reacted("confused")) {
        return { state: "reviewed", at: null, avatarUrl: null };
      }
      return reacted("eyes") ? { state: "reviewing", at: null, avatarUrl: null } : null;
    },
  },
  // A review request that drops off once it has reviewed; no check.
  { name: "Copilot", logins: ["copilot-pull-request-reviewer", "copilot"], checks: [] },
  { name: "Cursor Bugbot", logins: ["cursor"], checks: ["Cursor Bugbot"] },
  {
    name: "Claude",
    logins: CLAUDE,
    checks: ["Claude Code Review"],
    progress: claudeActionProgress,
  },
  { name: "Macroscope", logins: ["macroscopeapp"], checks: [/^Macroscope - /] },
  { name: "Sourcery", logins: ["sourcery-ai"], checks: ["Sourcery review"] },
  { name: "Codex", logins: CODEX, checks: [], progress: codexProgress },
  // Gemini's summary keeps saying "currently reviewing" after it is done, so only its review counts.
  { name: "Gemini", logins: ["gemini-code-assist"], checks: [] },
  { name: "Qodo", logins: QODO, checks: [], progress: qodoProgress },
  // Graphite's own check tracks stack mergeability, not its review; only the review counts.
  { name: "Graphite", logins: ["graphite-app"], checks: [] },
  // A passing Ellipsis review posts nothing, so only a failing one is ever seen.
  { name: "Ellipsis", logins: ["ellipsis-dev"], checks: [] },
];

// Codex keeps one summary comment whose table row reads `| 📝 **Code Review** | **Running** | ...`.
function codexProgress(signals: Signals, now: number): Progress | null {
  const summary = latestComment(signals, CODEX, (body) =>
    body.includes("<!-- codex-pull-request-review-summary -->"),
  );
  const row = summary?.body.match(/\*\*Code Review\*\*\s*\|\s*\*\*(Running|Completed)\*\*/u);
  if (summary !== null && row != null) {
    const at = activeAt(summary);
    if (row[1] === "Completed") return { state: "reviewed", at, avatarUrl: summary.avatarUrl };
    return fresh(at, now) ? { state: "reviewing", at, avatarUrl: summary.avatarUrl } : null;
  }
  const clean = signals.reactions.some(
    (group) => group.content === "thumbs_up" && group.logins.some((login) => CODEX.includes(login)),
  );
  return clean ? { state: "reviewed", at: null, avatarUrl: null } : null;
}

// The Claude GitHub Action edits one tracking comment from "Claude Code is working…" to
// "Claude finished …" or "Claude encountered an error …".
function claudeActionProgress(signals: Signals, now: number): Progress | null {
  const comment = latestComment(
    signals,
    [...CLAUDE, "github-actions"],
    (body) =>
      body.includes("Claude Code is working") ||
      body.includes("Claude finished") ||
      body.includes("Claude encountered an error"),
  );
  if (comment === null) return null;
  const at = activeAt(comment);
  if (!comment.body.includes("Claude Code is working")) {
    return { state: "reviewed", at, avatarUrl: comment.avatarUrl };
  }
  return fresh(at, now) ? { state: "reviewing", at, avatarUrl: comment.avatarUrl } : null;
}

// Qodo posts a temporary "Preparing review..." comment and deletes it when its review lands.
function qodoProgress(signals: Signals, now: number): Progress | null {
  const review = latestComment(signals, QODO, (body) => body.includes("<!-- pr-agent:review"));
  const preparing = latestComment(signals, QODO, (body) => body.includes("Preparing review"));
  if (preparing !== null && fresh(activeAt(preparing), now)) {
    return { state: "reviewing", at: activeAt(preparing), avatarUrl: preparing.avatarUrl };
  }
  return review === null
    ? null
    : { state: "reviewed", at: activeAt(review), avatarUrl: review.avatarUrl };
}

/** A custom entry names a bot login, a check name, or both at once. */
function customBot(entry: string): ReviewBot {
  const name = entry.trim();
  return { name, logins: [name.toLowerCase().replace(/\[bot\]$/u, "")], checks: [name] };
}

export function reviewBots(custom: ReadonlyArray<string>): ReadonlyArray<ReviewBot> {
  const known = new Set(BUILT_IN_BOTS.flatMap((bot) => bot.logins));
  return [
    ...BUILT_IN_BOTS,
    ...custom.map(customBot).filter((bot) => !bot.logins.some((login) => known.has(login))),
  ];
}

const namesCheck = (bot: ReviewBot, check: Check) =>
  bot.checks.some((name) =>
    typeof name === "string"
      ? name.toLowerCase() === check.name.toLowerCase()
      : name.test(check.name),
  );

/**
 * A check is the bot's when the app or account behind it is the bot. A documented name stands in
 * only where the host does not say who posted it, or names an account no bot here uses.
 */
function botChecks(bot: ReviewBot, signals: Signals, allLogins: ReadonlySet<string>) {
  return signals.checks.filter((check) =>
    check.actor !== null && allLogins.has(check.actor)
      ? bot.logins.includes(check.actor) && (bot.checks.length === 0 || namesCheck(bot, check))
      : namesCheck(bot, check),
  );
}

const earliest = (times: ReadonlyArray<string | null>) =>
  times.filter((at) => at !== null).toSorted()[0] ?? null;
const latest = (times: ReadonlyArray<string | null>) =>
  times
    .filter((at) => at !== null)
    .toSorted()
    .at(-1) ?? null;

/**
 * Each bot is read from its strongest signal: its checks on the head commit, then its own progress
 * markers, then a pending review request, then its latest review.
 */
function resolveBot(
  bot: ReviewBot,
  signals: Signals,
  allLogins: ReadonlySet<string>,
  now: number,
): ThreadPullRequestAiReviewer | null {
  const findings = signals.openThreadAuthors.filter((login) => bot.logins.includes(login)).length;
  const reviewer = (
    state: ThreadPullRequestAiReviewer["state"],
    times: { readonly startedAt?: string | null; readonly completedAt?: string | null },
    avatarUrl: string | null,
  ): ThreadPullRequestAiReviewer => ({
    name: bot.name,
    avatarUrl: avatarUrl ?? avatarOf(bot, signals),
    state,
    startedAt: times.startedAt ?? null,
    completedAt: times.completedAt ?? null,
    findings,
  });

  const checks = botChecks(bot, signals, allLogins);
  const checkAvatar = checks.find((check) => check.avatarUrl !== null)?.avatarUrl ?? null;
  const pending = checks.filter((check) => check.status === "pending");
  if (pending.length > 0) {
    return reviewer(
      "reviewing",
      { startedAt: earliest(pending.map((c) => c.startedAt)) },
      checkAvatar,
    );
  }
  const reviewed = checks.filter(
    (check) =>
      check.conclusion !== "skipped" &&
      check.conclusion !== "cancelled" &&
      check.conclusion !== "stale" &&
      bot.skippedCheck?.(check) !== true,
  );
  if (reviewed.length > 0) {
    return reviewer(
      "reviewed",
      { completedAt: latest(reviewed.map((check) => check.completedAt)) },
      checkAvatar,
    );
  }

  const progress = bot.progress?.(signals, now) ?? null;
  if (progress !== null) {
    return reviewer(
      progress.state,
      progress.state === "reviewing" ? { startedAt: progress.at } : { completedAt: progress.at },
      progress.avatarUrl,
    );
  }

  const requested = signals.requestedReviewers.find((r) => bot.logins.includes(r.login));
  if (requested !== undefined) return reviewer("reviewing", {}, requested.avatarUrl);

  const reviews = signals.reviews.filter((review) => bot.logins.includes(review.login));
  if (reviews.length > 0) {
    return reviewer("reviewed", { completedAt: latest(reviews.map((r) => r.submittedAt)) }, null);
  }
  return null;
}

function avatarOf(bot: ReviewBot, signals: Signals): string | null {
  const actors = [...signals.reviews, ...signals.comments, ...signals.requestedReviewers];
  return (
    actors.find((actor) => bot.logins.includes(actor.login) && actor.avatarUrl !== null)
      ?.avatarUrl ?? null
  );
}

export interface AiReviewInput {
  readonly signals: Signals;
  readonly customReviewers: ReadonlyArray<string>;
  readonly now: number;
}

export function resolveAiReview(input: AiReviewInput): ThreadPullRequestAiReview | undefined {
  const bots = reviewBots(input.customReviewers);
  const allLogins = new Set(bots.flatMap((bot) => bot.logins));
  const reviewers = bots.flatMap((bot) => {
    const resolved = resolveBot(bot, input.signals, allLogins, input.now);
    return resolved === null ? [] : [resolved];
  });
  if (reviewers.length === 0) return undefined;
  const reviewing = reviewers.filter((reviewer) => reviewer.state === "reviewing");
  return {
    state: reviewing.length > 0 ? "reviewing" : "reviewed",
    reviewers,
    startedAt: earliest(reviewing.map((reviewer) => reviewer.startedAt)),
    completedAt:
      reviewing.length > 0 ? null : latest(reviewers.map((reviewer) => reviewer.completedAt)),
  };
}

export function aiReviewsEqual(
  left: ThreadPullRequestAiReview | undefined,
  right: ThreadPullRequestAiReview | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.state === right.state &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.reviewers.length === right.reviewers.length &&
    left.reviewers.every((reviewer, index) => {
      const other = right.reviewers[index]!;
      return (
        reviewer.name === other.name &&
        reviewer.avatarUrl === other.avatarUrl &&
        reviewer.state === other.state &&
        reviewer.startedAt === other.startedAt &&
        reviewer.completedAt === other.completedAt &&
        reviewer.findings === other.findings
      );
    })
  );
}
