// The Jira REST calls of the runner, cut from the loop's. A failed call fails the tick, and the next tick reads again.
export type Ticket = {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  done: boolean;
  flagged: boolean;
  /** The Jira components: the repos the ticket changes. */
  components: string[];
  blockers: { key: string; done: boolean }[];
  /** The description, a line for each block, with the target of each link. */
  text: string;
};

export type TicketComment = { text: string; created: string };

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
    const fields = ["summary", "status", "issuetype", "issuelinks", "components", "description", flagged];
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

  async comments(key: string): Promise<TicketComment[]> {
    const found: TicketComment[] = [];
    for (let start = 0; ; ) {
      const page = await this.request("GET", `/rest/api/3/issue/${key}/comment?orderBy=created&startAt=${start}`);
      const comments: Fields[] = page.comments ?? [];
      for (const comment of comments) found.push({ text: textOf(comment.body).trim(), created: comment.created });
      start += comments.length;
      if (!comments.length || start >= (page.total ?? 0)) return found;
    }
  }

  async comment(key: string, text: string): Promise<void> {
    const content = text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
    await this.request("POST", `/rest/api/3/issue/${key}/comment`, { body: { type: "doc", version: 1, content } });
  }

  /** Sets the Flagged field, the mark of a ticket that waits on the owner. */
  async flag(key: string): Promise<void> {
    const field = await this.flaggedField();
    await this.request("PUT", `/rest/api/3/issue/${key}`, { fields: { [field]: [{ value: "Impediment" }] } });
  }

  /** Moves the ticket to the status of that name, through the transition that leads there. */
  async transition(key: string, status: string): Promise<void> {
    const path = `/rest/api/3/issue/${key}/transitions`;
    const { transitions = [] } = await this.request("GET", path);
    const match = (transitions as Fields[]).find((item) => item.to?.name === status || item.name === status);
    if (!match) throw new Error(`${key} has no transition to ${status}`);
    await this.request("POST", path, { transition: { id: match.id } });
  }

  /** Replaces the text in the description, in its text and its link targets. */
  async replaceInDescription(key: string, old: string, text: string): Promise<void> {
    const data = await this.request("GET", `/rest/api/3/issue/${key}?fields=description`);
    const raw = JSON.stringify(data.fields?.description ?? null);
    if (!raw.includes(old)) return;
    await this.request("PUT", `/rest/api/3/issue/${key}`, { fields: { description: JSON.parse(raw.replaceAll(old, text)) } });
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

/** The text of a comment's document, enough to read how it starts. */
function textOf(node: Fields | undefined): string {
  return String(node?.text ?? "") + ((node?.content ?? []) as Fields[]).map(textOf).join("");
}

function descriptionOf(node: Fields | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") {
    const href = (node.marks as Fields[] | undefined)?.find((mark) => mark.type === "link")?.attrs?.href;
    return href ? `[${node.text}](${href})` : String(node.text ?? "");
  }
  if (node.type === "inlineCard") return String(node.attrs?.url ?? "");
  if (node.type === "hardBreak") return "\n";
  const inner = ((node.content ?? []) as Fields[]).map(descriptionOf);
  return inner.join(node.type === "paragraph" || node.type === "heading" ? "" : "\n");
}

function parse(data: Fields, flagged: string): Ticket {
  const fields: Fields = data.fields ?? {};
  const links: Fields[] = fields.issuelinks ?? [];
  return {
    key: data.key,
    summary: fields.summary ?? "",
    issueType: fields.issuetype?.name ?? "Task",
    status: fields.status?.name ?? "",
    done: fields.status?.statusCategory?.key === "done",
    flagged: Boolean(fields[flagged]),
    components: ((fields.components ?? []) as Fields[]).map((component) => component.name),
    text: descriptionOf(fields.description),
    blockers: links
      .filter((link) => link.type?.name === "Blocks" && link.inwardIssue)
      .map((link) => ({ key: link.inwardIssue.key, done: link.inwardIssue.fields?.status?.statusCategory?.key === "done" })),
  };
}
