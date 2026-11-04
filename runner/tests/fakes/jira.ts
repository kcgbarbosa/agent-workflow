// A fake Jira on a local port. It holds issues in memory, answers only the JQL the runner sends, and records each
// write. It pages its search, so a runner that reads one page misses tickets.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Issue = {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  components: string[];
  flagged: boolean;
  /** The tickets that block this one, each with its status. */
  blockedBy: Record<string, string>;
  comments: { text: string; created: string }[];
};

const FLAGGED = "customfield_10021";
const PAGE = 2;
const PRIORITIES = ["Lowest", "Low", "Medium", "High", "Highest"];
const JQL = /^component = "([^"]+)" AND statusCategory != Done ORDER BY priority DESC, key ASC$/;

/** A time as Jira writes it, with no colon in its offset. */
export function jiraTime(ms: number): string {
  return new Date(ms - 5 * 3_600_000).toISOString().replace("Z", "-0500");
}

function category(status: string) {
  return { key: status === "Done" ? "done" : status === "To Do" || status === "Backlog" ? "new" : "indeterminate" };
}

export class FakeJira {
  issues = new Map<string, Issue>();
  /** Each write, as `METHOD path` with the status of a transition. */
  writes: string[] = [];
  /** The status to answer every request with, as an outage or an expired token does. */
  down: number | null = null;
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const [status, body] = this.answer(request.method ?? "GET", request.url ?? "/", raw);
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  add(key: string, summary: string, values: Partial<Issue> = {}): void {
    this.issues.set(key, {
      key,
      summary,
      status: "To Do",
      issueType: "Task",
      priority: "Medium",
      components: ["agent-workflow"],
      flagged: false,
      blockedBy: {},
      comments: [],
      ...values,
    });
  }

  private answer(method: string, url: string, raw: string): [number, unknown] {
    if (this.down !== null) return [this.down, { errorMessages: ["down"] }];
    const { pathname } = new URL(url, "http://jira");
    const body = raw ? JSON.parse(raw) : null;
    if (pathname === "/rest/api/3/field") return [200, [{ id: FLAGGED, name: "Flagged" }]];
    if (method === "POST" && pathname === "/rest/api/3/search/jql") return this.search(body);
    const commented = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(pathname);
    if (commented) return this.comment(method, commented[1], url, body);
    const edited = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(pathname);
    if (edited && method === "PUT") return this.edit(edited[1], body);
    const transitions = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(pathname);
    const issue = transitions ? this.issues.get(transitions[1]) : undefined;
    if (issue && method === "GET") {
      return [200, { transitions: ["To Do", "In Progress", "In Review", "Done"].map((name) => ({ id: name, name, to: { name } })) }];
    }
    if (issue && method === "POST") {
      issue.status = body.transition.id;
      this.writes.push(`transition ${issue.key} ${issue.status}`);
      return [204, null];
    }
    return [404, { errorMessages: [`no route for ${method} ${pathname}`] }];
  }

  private comment(method: string, key: string, url: string, body: any): [number, unknown] {
    const issue = this.issues.get(key);
    if (!issue) return [404, { errorMessages: [`no issue ${key}`] }];
    if (method === "POST") {
      const text = body.body.content.map((block: any) => block.content.map((node: any) => node.text).join("")).join("\n");
      issue.comments.push({ text, created: jiraTime(Date.now()) });
      this.writes.push(`comment ${key} ${text}`);
      return [201, {}];
    }
    // A page of one, so a runner that reads one page misses comments.
    const start = Number(new URL(url, "http://jira").searchParams.get("startAt") ?? 0);
    const comments = issue.comments.slice(start, start + 1).map(({ text, created }) => ({
      created,
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    }));
    return [200, { comments, total: issue.comments.length }];
  }

  private edit(key: string, body: any): [number, unknown] {
    const issue = this.issues.get(key);
    if (!issue || !body.fields?.[FLAGGED]) return [400, { errorMessages: [`bad edit of ${key}`] }];
    issue.flagged = true;
    this.writes.push(`flag ${key}`);
    return [204, null];
  }

  private search(body: { jql: string; nextPageToken?: string }): [number, unknown] {
    const match = JQL.exec(body.jql);
    if (!match) return [400, { errorMessages: [`unknown JQL: ${body.jql}`] }];
    const found = [...this.issues.values()]
      .filter((issue) => issue.components.includes(match[1]) && issue.status !== "Done")
      .sort(
        (a, b) =>
          PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || Number(a.key.split("-")[1]) - Number(b.key.split("-")[1]),
      );
    const start = Number(body.nextPageToken ?? 0);
    const next = start + PAGE;
    return [
      200,
      {
        issues: found.slice(start, next).map((issue) => this.fields(issue)),
        isLast: next >= found.length,
        nextPageToken: next >= found.length ? undefined : String(next),
      },
    ];
  }

  private fields(issue: Issue): unknown {
    return {
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status, statusCategory: category(issue.status) },
        issuetype: { name: issue.issueType },
        components: issue.components.map((name) => ({ name })),
        [FLAGGED]: issue.flagged ? [{ value: "Impediment" }] : null,
        issuelinks: [
          // The other direction of a link, which blocks nothing here.
          { type: { name: "Blocks" }, outwardIssue: { key: "AW-999", fields: { status: { statusCategory: category("To Do") } } } },
          ...Object.entries(issue.blockedBy).map(([key, status]) => ({
            type: { name: "Blocks" },
            inwardIssue: { key, fields: { status: { name: status, statusCategory: category(status) } } },
          })),
        ],
      },
    };
  }
}
