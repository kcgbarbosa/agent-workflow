// The one way the runner reaches the owner: the Slack channel of the repo, through its incoming webhook.
const SECONDS = 30;

/** The three characters Slack reads as markup in a message's text. */
function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Posts the message, and throws when Slack refuses it. The webhook is a secret, so no error names the address. */
export async function post(webhook: string, message: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: escaped(message) }),
      signal: AbortSignal.timeout(SECONDS * 1000),
    });
  } catch (error) {
    throw new Error(`Slack: ${(error as Error).name}`);
  }
  if (!response.ok) throw new Error(`Slack: HTTP ${response.status}`);
}
