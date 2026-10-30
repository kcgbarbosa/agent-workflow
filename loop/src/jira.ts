// The Jira REST calls the loop makes. A read retries a busy Jira, and a write is sent once.
export class JiraError extends Error {}

export type Ticket = {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  done: boolean;
  flagged: boolean;
  blockers: { key: string; done: boolean }[];
  parent: string | null;
  text: string;
};

const SEARCH = "/rest/api/3/search/jql";
const ATTEMPTS = 4;
const BACKOFF_MS = 5_000;
const MAX_WAIT_MS = 120_000;

type Fields = Record<string, any>;

export class Jira {
  private readonly base: string;
  private readonly auth: string;
  private flaggedId: string | null = null;

  constructor(base: string, email: string, token: string) {
    this.base = base.replace(/\/$/, "");
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  async myself(): Promise<void> {
    await this.request("GET", "/rest/api/3/myself");
  }

  async ticket(key: string): Promise<Ticket> {
    const fields = (await this.fields()).join(",");
    return this.parse(await this.request("GET", `/rest/api/3/issue/${key}?fields=${fields}`));
  }

  async search(jql: string): Promise<Ticket[]> {
    const fields = await this.fields();
    const tickets: Ticket[] = [];
    let token: string | undefined;
    for (;;) {
      const body: Fields = { jql, fields, maxResults: 100 };
      if (token) body.nextPageToken = token;
      const page = await this.request("POST", SEARCH, body);
      for (const issue of page.issues ?? []) tickets.push(this.parse(issue));
      if (page.isLast || !page.nextPageToken) return tickets;
      token = page.nextPageToken;
    }
  }

  async comments(key: string): Promise<string[]> {
    const texts: string[] = [];
    for (let start = 0; ; ) {
      const page = await this.request("GET", `/rest/api/3/issue/${key}/comment?orderBy=created&startAt=${start}`);
      const comments: Fields[] = page.comments ?? [];
      for (const comment of comments) texts.push(adfToText(comment.body).trim());
      start += comments.length;
      if (!comments.length || start >= (page.total ?? 0)) return texts;
    }
  }

  /** Replaces the text in the description, in its text and its link targets. */
  async replaceInDescription(key: string, old: string, text: string): Promise<void> {
    const data = await this.request("GET", `/rest/api/3/issue/${key}?fields=description`);
    const raw = JSON.stringify(data.fields?.description ?? null);
    if (!raw.includes(old)) return;
    await this.request("PUT", `/rest/api/3/issue/${key}`, { fields: { description: JSON.parse(raw.replaceAll(old, text)) } });
  }

  /** Moves the ticket to the status of that name, through the transition that leads there. */
  async transition(key: string, status: string): Promise<void> {
    const path = `/rest/api/3/issue/${key}/transitions`;
    const { transitions = [] } = await this.request("GET", path);
    const match = (transitions as Fields[]).find((item) => item.to?.name === status || item.name === status);
    if (!match) throw new JiraError(`${key} has no transition to ${status}`);
    await this.request("POST", path, { transition: { id: match.id } });
  }

  /** Sets the Flagged field, the loop's mark of a stuck ticket. */
  async flag(key: string): Promise<void> {
    const field = await this.flaggedField();
    await this.request("PUT", `/rest/api/3/issue/${key}`, { fields: { [field]: [{ value: "Impediment" }] } });
  }

  async comment(key: string, text: string): Promise<void> {
    const content = text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
    await this.request("POST", `/rest/api/3/issue/${key}/comment`, { body: { type: "doc", version: 1, content } });
  }

  private async fields(): Promise<string[]> {
    return ["summary", "status", "issuetype", "description", "issuelinks", "parent", await this.flaggedField()];
  }

  private async flaggedField(): Promise<string> {
    if (this.flaggedId === null) {
      const fields: Fields[] = await this.request("GET", "/rest/api/3/field");
      this.flaggedId = fields.find((field) => field.name === "Flagged")?.id ?? "customfield_10021";
    }
    return this.flaggedId as string;
  }

  private parse(data: Fields): Ticket {
    const fields: Fields = data.fields ?? {};
    const links: Fields[] = fields.issuelinks ?? [];
    return {
      key: data.key,
      summary: fields.summary ?? "",
      issueType: fields.issuetype?.name ?? "Task",
      status: fields.status?.name ?? "",
      done: isDone(fields.status),
      flagged: Boolean(fields[this.flaggedId ?? "customfield_10021"]),
      blockers: links
        .filter((link) => link.type?.name === "Blocks" && link.inwardIssue)
        .map((link) => ({ key: link.inwardIssue.key, done: isDone(link.inwardIssue.fields?.status) })),
      parent: fields.parent?.key ?? null,
      text: adfToText(fields.description),
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: this.auth, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const retry = method === "GET" || path === SEARCH;
    for (let attempt = 1; ; attempt++) {
      let wait: number | null = null;
      try {
        const response = await fetch(this.base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        if (response.ok) return text ? JSON.parse(text) : null;
        const busy = response.status === 429 || response.status >= 500;
        if (!(retry && busy) || attempt === ATTEMPTS) {
          throw new JiraError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
        }
        const after = Number(response.headers.get("Retry-After"));
        wait = Number.isFinite(after) && after > 0 ? after * 1000 : null;
      } catch (error) {
        if (error instanceof JiraError) throw error;
        if (!retry || attempt === ATTEMPTS) throw new JiraError(`${method} ${path}: ${(error as Error).message}`);
      }
      const backoff = BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait ?? backoff, MAX_WAIT_MS)));
    }
  }
}

function isDone(status: Fields | undefined): boolean {
  return status?.statusCategory?.key === "done";
}

/** Turns an Atlassian Document Format body into plain text for the ticket file. */
export function adfToText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const item = node as Fields;
  const kind = item.type;
  if (kind === "text") {
    let text = String(item.text ?? "");
    for (const mark of item.marks ?? []) {
      if (mark.type === "code") text = `\`${text}\``;
      else if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
    }
    return text;
  }
  if (kind === "hardBreak") return "\n";
  if (kind === "inlineCard") return String(item.attrs?.url ?? "");
  const children: unknown[] = item.content ?? [];
  if (kind === "bulletList" || kind === "orderedList") {
    const items = children.map((child, index) => {
      const marker = kind === "orderedList" ? `${index + 1}.` : "-";
      return `${marker} ${adfToText(child).trim().replaceAll("\n", "\n  ")}`;
    });
    return items.join("\n") + "\n\n";
  }
  const inner = children.map(adfToText).join("");
  if (kind === "heading") return `${"#".repeat(Number(item.attrs?.level ?? 2))} ${inner}\n\n`;
  if (kind === "codeBlock") return `\`\`\`\n${inner}\n\`\`\`\n\n`;
  if (kind === "paragraph") return `${inner}\n\n`;
  if (kind === "listItem") return inner.trim() + "\n";
  return inner;
}
