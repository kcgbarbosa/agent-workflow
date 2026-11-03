// The one way the loop reaches the owner: the ntfy topic, or the Slack webhook of the repo's channel.
import type { Config } from "./config.ts";

const SECONDS = 30;

/** Posts the message to the repo's channel, and throws when the channel refuses it. */
export async function post(config: Config, secrets: Record<string, string>, message: string): Promise<void> {
  const signal = AbortSignal.timeout(SECONDS * 1000);
  const response =
    config.notify.kind === "slack"
      ? await fetch(secrets[config.notify.secret]!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
          signal,
        })
      : await fetch(`${config.ntfyUrl.replace(/\/$/, "")}/${secrets.NTFY_TOPIC}`, { method: "POST", body: message, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
