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
  /** The changelog, oldest first, as Jira writes it. */
  history: { created: string; items: { field: string; to: string | null; toString: string | null }[] }[];
  parent: string | null;
  /** The description as Jira holds it, a document. */
  description: unknown;
};

const FLAGGED = "customfield_10021";
const PAGE = 2;
const PRIORITIES = ["Lowest", "Low", "Medium", "High", "Highest"];
const JQL = /^component = "([^"]+)" AND statusCategory != Done ORDER BY priority DESC, key ASC$/;
const OPEN_EPICS = "issuetype = Epic AND statusCategory != Done ORDER BY key ASC";
const DONE_EPICS = "issuetype = Epic AND statusCategory = Done ORDER BY key ASC";
const OPEN_TICKETS_NAMING = /^issuetype != Epic AND statusCategory != Done AND description ~ "\\"(.+)\\"" ORDER BY key ASC$/;
const CHILDREN = /^parent = ([A-Z]+-\d+) ORDER BY key ASC$/;
const NAMING = /^issuetype = Epic AND description ~ "\\"(.+)\\"" ORDER BY key ASC$/;

/** A time as Jira writes it, with no colon in its offset. */
export function jiraTime(ms: number): string {
  return new Date(ms - 5 * 3_600_000).toISOString().replace("Z", "-0500");
}

function category(status: string) {
  return { key: status === "Done" ? "done" : status === "To Do" || status === "Awaiting Approval" ? "new" : "indeterminate" };
}

/** A description of one line, `Spec: <link>`, as `/to-spec` writes it: the URL is both the text and the link's target. */
export function specLine(url: string): unknown {
  const link = { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] };
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Spec: " }, link] }] };
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
      history: [],
      parent: null,
      description: null,
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
    const changelog = /^\/rest\/api\/3\/issue\/([^/]+)\/changelog$/.exec(pathname);
    if (changelog && method === "GET") return this.changelog(changelog[1], url);
    const edited = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(pathname);
    if (edited && method === "PUT") return this.edit(edited[1], body);
    if (edited && method === "GET" && this.issues.has(edited[1])) return [200, this.fields(this.issues.get(edited[1])!)];
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

  /** A page of one, so a runner that reads one page misses the latest change. */
  private changelog(key: string, url: string): [number, unknown] {
    const issue = this.issues.get(key);
    if (!issue) return [404, { errorMessages: [`no issue ${key}`] }];
    const start = Number(new URL(url, "http://jira").searchParams.get("startAt") ?? 0);
    return [200, { values: issue.history.slice(start, start + 1), total: issue.history.length }];
  }

  private edit(key: string, body: any): [number, unknown] {
    const issue = this.issues.get(key);
    if (issue && body.fields?.description) {
      issue.description = body.fields.description;
      this.writes.push(`describe ${key}`);
      return [204, null];
    }
    if (!issue || !body.fields?.[FLAGGED]) return [400, { errorMessages: [`bad edit of ${key}`] }];
    issue.flagged = true;
    issue.history.push({ created: jiraTime(Date.now()), items: [{ field: "Flagged", to: "[10019]", toString: "Impediment" }] });
    this.writes.push(`flag ${key}`);
    return [204, null];
  }

  private search(body: { jql: string; nextPageToken?: string }): [number, unknown] {
    const found = this.matching(body.jql);
    if (!found) return [400, { errorMessages: [`unknown JQL: ${body.jql}`] }];
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

  private matching(jql: string): Issue[] | null {
    const all = [...this.issues.values()];
    const byKey = (a: Issue, b: Issue) => Number(a.key.split("-")[1]) - Number(b.key.split("-")[1]);
    const queue = JQL.exec(jql);
    if (queue) {
      return all
        .filter((issue) => issue.components.includes(queue[1]) && issue.status !== "Done")
        .sort((a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || byKey(a, b));
    }
    if (jql === OPEN_EPICS) return all.filter((issue) => issue.issueType === "Epic" && issue.status !== "Done").sort(byKey);
    if (jql === DONE_EPICS) return all.filter((issue) => issue.issueType === "Epic" && issue.status === "Done").sort(byKey);
    const ticketsNaming = OPEN_TICKETS_NAMING.exec(jql);
    if (ticketsNaming) return all.filter((issue) => issue.issueType !== "Epic" && issue.status !== "Done" && JSON.stringify(issue.description).includes(ticketsNaming[1])).sort(byKey);
    const children = CHILDREN.exec(jql);
    if (children) return all.filter((issue) => issue.parent === children[1]).sort(byKey);
    const naming = NAMING.exec(jql);
    if (naming) return all.filter((issue) => issue.issueType === "Epic" && JSON.stringify(issue.description).includes(naming[1])).sort(byKey);
    return null;
  }

  private fields(issue: Issue): unknown {
    return {
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status, statusCategory: category(issue.status) },
        issuetype: { name: issue.issueType },
        components: issue.components.map((name) => ({ name })),
        description: issue.description,
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
