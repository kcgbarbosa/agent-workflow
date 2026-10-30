// The fake Jira, served in the test process on a free port. It answers the calls the loop makes, records
// each transition, and takes a filter's tickets from `filters`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Issue = {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  parent: string | null;
  blockers: string[];
  flagged: boolean;
  comments: string[];
  body: string[];
  /** The statuses the loop moved the issue to, in order. */
  statuses: string[];
};

const STATUSES = ["To Do", "In Progress", "In Review", "Done"];
const PAGE = 2;

function category(status: string): string {
  return status === "Done" ? "done" : status === "To Do" ? "new" : "indeterminate";
}

function adf(paragraphs: string[]) {
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}

export class FakeJira {
  readonly issues = new Map<string, Issue>();
  readonly filters = new Map<string, string[]>();
  readonly requests: string[] = [];
  readonly notifications: string[] = [];
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeJira> {
    const server = createServer();
    const jira = new FakeJira(server);
    server.on("request", (request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const [status, body] = jira.answer(request.method ?? "GET", request.url ?? "/", raw);
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(body === undefined ? "" : JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return jira;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  add(key: string, summary: string, values: Partial<Issue> = {}): Issue {
    const issue: Issue = {
      key,
      summary,
      status: "To Do",
      issueType: "Task",
      parent: null,
      blockers: [],
      flagged: false,
      comments: [],
      body: [`The work of ${key}.`],
      statuses: [],
      ...values,
    };
    this.issues.set(key, issue);
    return issue;
  }

  private json(issue: Issue) {
    return {
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status, statusCategory: { key: category(issue.status) } },
        issuetype: { name: issue.issueType },
        description: adf(issue.body),
        parent: issue.parent ? { key: issue.parent } : null,
        customfield_10021: issue.flagged ? [{ value: "Impediment" }] : null,
        issuelinks: issue.blockers.map((key) => {
          const status = this.issues.get(key)?.status ?? "To Do";
          return {
            type: { name: "Blocks" },
            inwardIssue: { key, fields: { status: { name: status, statusCategory: { key: category(status) } } } },
          };
        }),
      },
    };
  }

  private search(jql: string): Issue[] {
    const parent = /^parent = ([A-Z][A-Z0-9]*-\d+) ORDER BY key ASC$/.exec(jql);
    const keys = parent
      ? [...this.issues.values()].filter((issue) => issue.parent === parent[1]).map((issue) => issue.key).sort()
      : this.filters.get(jql);
    if (!keys) throw new Error(`The fake Jira knows no JQL ${jql}`);
    return keys.map((key) => this.issues.get(key)!);
  }

  private answer(method: string, url: string, raw: string): [number, unknown] {
    const { pathname, searchParams } = new URL(url, "http://jira");
    this.requests.push(`${method} ${pathname}`);
    const body = raw ? JSON.parse(method === "POST" && pathname.startsWith("/ntfy/") ? "null" : raw) : null;
    if (method === "POST" && pathname.startsWith("/ntfy/")) {
      this.notifications.push(raw);
      return [200, {}];
    }
    if (pathname === "/rest/api/3/myself") return [200, { accountId: "fake" }];
    if (pathname === "/rest/api/3/field") return [200, [{ id: "summary", name: "Summary" }, { id: "customfield_10021", name: "Flagged" }]];
    if (pathname === "/rest/api/3/search/jql" && method === "POST") {
      const found = this.search(body.jql);
      const start = Number(body.nextPageToken ?? 0);
      const page = found.slice(start, start + PAGE);
      const isLast = start + PAGE >= found.length;
      return [200, { issues: page.map((issue) => this.json(issue)), isLast, ...(isLast ? {} : { nextPageToken: String(start + PAGE) }) }];
    }
    const match = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/(\w+))?$/.exec(pathname);
    const issue = match ? this.issues.get(match[1]!) : undefined;
    if (!match || !issue) return [404, { errorMessages: ["Issue does not exist"] }];
    const part = match[2];
    if (!part && method === "GET") return [200, this.json(issue)];
    if (!part && method === "PUT") {
      if ("customfield_10021" in body.fields) issue.flagged = Boolean(body.fields.customfield_10021);
      if ("description" in body.fields) {
        issue.body = body.fields.description.content.map((paragraph: { content: { text: string }[] }) => paragraph.content.map((item) => item.text).join(""));
      }
      return [204, undefined];
    }
    if (part === "comment" && method === "POST") {
      const lines = body.body.content.map((paragraph: { content: { text: string }[] }) => paragraph.content.map((item) => item.text).join(""));
      issue.comments.push(lines.join("\n"));
      return [201, {}];
    }
    if (part === "transitions" && method === "GET") {
      const others = STATUSES.filter((status) => status !== issue.status);
      return [200, { transitions: others.map((status) => ({ id: status, name: status, to: { name: status } })) }];
    }
    if (part === "transitions" && method === "POST") {
      issue.status = body.transition.id;
      issue.statuses.push(issue.status);
      return [204, undefined];
    }
    if (part === "comment" && method === "GET") {
      const start = Number(searchParams.get("startAt") ?? 0);
      const comments = issue.comments.slice(start, start + PAGE).map((text) => ({ body: adf([text]) }));
      return [200, { startAt: start, maxResults: PAGE, total: issue.comments.length, comments }];
    }
    return [405, { errorMessages: [`The fake Jira has no ${method} ${pathname}`] }];
  }
}
