// The one way the runner reaches the owner: the ntfy topic.
const SECONDS = 30;

/** Posts the message, and throws when ntfy refuses it. The topic is a secret, so no error names the address. */
export async function post(url: string, topic: string, message: string): Promise<void> {
  const response = await fetch(`${url.replace(/\/$/, "")}/${topic}`, { method: "POST", body: message, signal: AbortSignal.timeout(SECONDS * 1000) });
  if (!response.ok) throw new Error(`ntfy: HTTP ${response.status}`);
}
