// A fake Slack on a local port. It records each post to a webhook with its path.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export class FakeSlack {
  posts: { path: string; text: string }[] = [];
  /** The status to answer with, as a refusal or an outage does. */
  down: number | null = null;
  /** Whether this post fails, as a blip between two writes of a tick does. */
  failsWrite: () => boolean = () => false;
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const status = this.down ?? (this.failsWrite() ? 503 : 200);
        if (status === 200) this.posts.push({ path: request.url ?? "", text: JSON.parse(body).text });
        response.writeHead(status);
        response.end();
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
}
