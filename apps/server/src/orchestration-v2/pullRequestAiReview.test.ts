import type { ProviderChangeRequestReviewSignals } from "@t3tools/source-control-core/server/PullRequestProvider";
import { assert, describe, it } from "@effect/vitest";

import { AI_REVIEW_IN_PROGRESS_LIMIT_MS, resolveAiReview } from "./pullRequestAiReview.ts";

type Signals = ProviderChangeRequestReviewSignals;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const signals = (overrides: Partial<Signals> = {}): Signals => ({
  headSha: "head",
  checks: [],
  requestedReviewers: [],
  reviews: [],
  openThreadAuthors: [],
  reactions: [],
  comments: [],
  ...overrides,
});

const check = (
  name: string,
  actor: string | null,
  conclusion: string | null,
  description: string | null = null,
): Signals["checks"][number] => ({
  name,
  actor,
  avatarUrl: actor === null ? null : `https://avatars.example/${actor}`,
  status: conclusion === null ? "pending" : "completed",
  conclusion,
  description,
  startedAt: ago(5),
  completedAt: conclusion === null ? null : ago(1),
});

const comment = (login: string, body: string, minutesAgo = 1): Signals["comments"][number] => ({
  login,
  avatarUrl: null,
  body,
  createdAt: ago(minutesAgo),
  editedAt: null,
});

const resolve = (input: Partial<Signals>, customReviewers: ReadonlyArray<string> = []) =>
  resolveAiReview({ signals: signals(input), customReviewers, now: NOW });
const states = (input: Partial<Signals>, customReviewers?: ReadonlyArray<string>) =>
  Object.fromEntries(
    (resolve(input, customReviewers)?.reviewers ?? []).map((reviewer) => [
      reviewer.name,
      reviewer.state,
    ]),
  );

describe("resolveAiReview", () => {
  it("is absent when no review bot has touched the pull request", () => {
    assert.strictEqual(
      resolve({ checks: [check("test", "github-actions", null)], reviews: [] }),
      undefined,
    );
  });

  it("reads a bot's check on the head commit by the app that posted it", () => {
    assert.deepStrictEqual(
      states({
        checks: [
          check("Greptile Review", "greptile-apps", null),
          check("Cursor Bugbot", "cursor", "neutral"),
        ],
      }),
      { Greptile: "reviewing", "Cursor Bugbot": "reviewed" },
    );
    // Another app cannot pose as a bot by naming its check after it.
    assert.strictEqual(resolve({ checks: [check("Greptile Review", "cursor", null)] }), undefined);
    // Where the host does not say who posted it, the documented name stands in.
    assert.deepStrictEqual(states({ checks: [check("Claude Code Review", null, null)] }), {
      Claude: "reviewing",
    });
  });

  it("does not count a check that finished without reviewing", () => {
    assert.strictEqual(
      resolve({ checks: [check("CodeRabbit", "coderabbitai", "success", "Review rate limited")] }),
      undefined,
    );
    assert.strictEqual(
      resolve({ checks: [check("Greptile Review", "greptile-apps", "skipped")] }),
      undefined,
    );
  });

  it("follows Copilot's review request until its review lands", () => {
    const request = { login: "copilot-pull-request-reviewer", avatarUrl: null };
    assert.deepStrictEqual(states({ requestedReviewers: [request] }), { Copilot: "reviewing" });
    assert.deepStrictEqual(
      states({
        reviews: [
          {
            login: "copilot-pull-request-reviewer",
            avatarUrl: null,
            submittedAt: ago(1),
            commitSha: "head",
          },
        ],
      }),
      { Copilot: "reviewed" },
    );
  });

  it("reads the progress markers of bots without checks", () => {
    const codex = (status: string) =>
      comment(
        "chatgpt-codex-connector",
        `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | **${status}** | \`abc1234\` | auto |`,
      );
    assert.deepStrictEqual(states({ comments: [codex("Running")] }), { Codex: "reviewing" });
    assert.deepStrictEqual(states({ comments: [codex("Completed")] }), { Codex: "reviewed" });
    assert.deepStrictEqual(
      states({ comments: [comment("claude", "Claude Code is working… <img>")] }),
      { Claude: "reviewing" },
    );
    assert.deepStrictEqual(
      states({ comments: [comment("claude", "**Claude finished @octocat's task in 2m**")] }),
      { Claude: "reviewed" },
    );
    assert.deepStrictEqual(
      states({ reactions: [{ content: "eyes", logins: ["greptile-apps"] }] }),
      { Greptile: "reviewing" },
    );
  });

  it("stops trusting a progress marker nobody finished", () => {
    const stale = AI_REVIEW_IN_PROGRESS_LIMIT_MS / 60_000 + 1;
    assert.strictEqual(
      resolve({ comments: [comment("claude", "Claude Code is working…", stale)] }),
      undefined,
    );
  });

  it("does not take Gemini's lasting summary for a review in progress", () => {
    assert.strictEqual(
      resolve({
        comments: [comment("gemini-code-assist", "I'm currently reviewing this pull request")],
      }),
      undefined,
    );
  });

  it("stays reviewing until every reviewer has finished, and counts open findings", () => {
    const review = resolve({
      checks: [
        check("CodeRabbit", "coderabbitai", "success", "Review completed"),
        check("Cursor Bugbot", "cursor", null),
      ],
      openThreadAuthors: ["coderabbitai", "coderabbitai", "octocat"],
    });
    assert.strictEqual(review?.state, "reviewing");
    assert.strictEqual(review?.startedAt, ago(5));
    assert.strictEqual(review?.completedAt, null);
    assert.deepStrictEqual(
      review?.reviewers.map(({ name, findings }) => [name, findings]),
      [
        ["CodeRabbit", 2],
        ["Cursor Bugbot", 0],
      ],
    );
  });

  it("recognizes a custom reviewer by login or check name", () => {
    assert.deepStrictEqual(
      states(
        {
          checks: [check("Internal Review", "acme-ci", null)],
          reviews: [
            { login: "acme-reviewer", avatarUrl: null, submittedAt: ago(1), commitSha: "head" },
          ],
        },
        ["acme-reviewer[bot]", "Internal Review"],
      ),
      { "acme-reviewer[bot]": "reviewed", "Internal Review": "reviewing" },
    );
  });
});
