// The Jira REST calls of the runner, cut from the loop's. A failed call fails the tick, and the next tick reads again.
export type Ticket = {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  flagged: boolean;
  blockers: { key: string; done: boolean }[];
};

const FALLBACK_FLAGGED = "customfield_10021";

type Fields = Record<string, any>;

export class Jira {
  private readonly base: string;
  private readonly auth: string;
  private flaggedId: string | null = null;

  constructor(base: string, email: string, token: string) {
    this.base = base.replace(/\/$/, "");
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  async search(jql: string): Promise<Ticket[]> {
    const flagged = await this.flaggedField();
    const fields = ["summary", "status", "issuetype", "issuelinks", flagged];
    const tickets: Ticket[] = [];
    let token: string | undefined;
    for (;;) {
      const body: Fields = { jql, fields, maxResults: 100 };
      if (token) body.nextPageToken = token;
      const page = await this.request("POST", "/rest/api/3/search/jql", body);
      for (const issue of page.issues ?? []) tickets.push(parse(issue, flagged));
      if (page.isLast || !page.nextPageToken) return tickets;
      token = page.nextPageToken;
    }
  }

  /** Moves the ticket to the status of that name, through the transition that leads there. */
  async transition(key: string, status: string): Promise<void> {
    const path = `/rest/api/3/issue/${key}/transitions`;
    const { transitions = [] } = await this.request("GET", path);
    const match = (transitions as Fields[]).find((item) => item.to?.name === status || item.name === status);
    if (!match) throw new Error(`${key} has no transition to ${status}`);
    await this.request("POST", path, { transition: { id: match.id } });
  }

  private async flaggedField(): Promise<string> {
    if (this.flaggedId === null) {
      const fields: Fields[] = await this.request("GET", "/rest/api/3/field");
      this.flaggedId = fields.find((field) => field.name === "Flagged")?.id ?? FALLBACK_FLAGGED;
    }
    return this.flaggedId as string;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: this.auth, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Jira ${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}

function parse(data: Fields, flagged: string): Ticket {
  const fields: Fields = data.fields ?? {};
  const links: Fields[] = fields.issuelinks ?? [];
  return {
    key: data.key,
    summary: fields.summary ?? "",
    issueType: fields.issuetype?.name ?? "Task",
    status: fields.status?.name ?? "",
    flagged: Boolean(fields[flagged]),
    blockers: links
      .filter((link) => link.type?.name === "Blocks" && link.inwardIssue)
      .map((link) => ({ key: link.inwardIssue.key, done: link.inwardIssue.fields?.status?.statusCategory?.key === "done" })),
  };
}
