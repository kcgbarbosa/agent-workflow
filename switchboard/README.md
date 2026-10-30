# Switchboard

A phone line to KC's Claude Code sessions. On CarPlay, KC says "Hey Siri, call Switchboard" and talks to one Claude Code session on the T14. That session lists the other sessions, reads how each one is doing, passes messages to them, and reads the replies back. It also grills, plans and triages on the call.

## How a call goes

```
iPhone (CarPlay) -> Twilio number -> ElevenLabs agent -> Tailscale Funnel (switchboard node) -> switchboard :8796 -> claude -p
```

- ElevenLabs does the speech both ways. Its agent's LLM is a custom LLM: this server, which speaks the OpenAI chat completions API and streams Server-Sent Events.
- The server keeps one `claude -p` running in stream-json mode, named `switchboard`, in auto mode. Only the last thing KC said goes in, since the session already holds the conversation. It lives across calls, and a restart resumes it from the ID in `~/.local/state/switchboard/session`.
- Other sessions reach it with `SendMessage` to `switchboard`. A reply wakes it for a turn of its own. What it says then is read out at the start of KC's next turn on the call.
- ElevenLabs gives up on a custom LLM that sends nothing for about 4 seconds and sends the same request again, sometimes two at once. So the call hears "One moment..." after 1 second of silence, then "Still working on it..." every 10 seconds. A request with the same words within 30 seconds joins the ask already running instead of starting a second turn. After 45 seconds the call hears that the rest comes when KC asks, and the rest waits for the next turn.
- `src/switchboard/prompt.md` is what the session is told about the call: how to talk, what it may do, and what waits for a screen.

## Run it

`switchboard.service` in the machines repo runs it on the T14 from `~/dev/agent-workflow/switchboard`, and its `80-switchboard` script puts it on Tailscale Funnel at `https://switchboard.tail4fca58.ts.net`, from a Tailscale node of its own so t14 stays off public DNS. The token is `SWITCHBOARD_TOKEN` in `~/.config/switchboard/env`, and the same value is the API key secret in ElevenLabs.

The start page's Switchboard card reads `/api/status` with the same token: whether the session runs, when KC last talked, and how many replies wait. `/health` answers without the token and says nothing more.

Run `uv run pytest` here. The tests use a stand-in `claude` in `tests/bin`.

## Set up the phone side

Done once, by KC, in the two dashboards.

1. Twilio: make an account and buy a Canadian local number with voice. It costs [$1.15 a month](https://www.twilio.com/en-us/voice/pricing/ca), plus minutes.
2. ElevenLabs, Agents: create an agent named Switchboard. Set the first message to "Switchboard here.", and pick a voice.
3. In the agent's LLM setting, choose Custom LLM. Server URL: `https://switchboard.tail4fca58.ts.net/v1`. Model ID: `switchboard`. API key: a new secret with the value of `SWITCHBOARD_TOKEN`. Publish.
4. Test it with the agent's test call in the browser. Ask "which of my sessions are busy?".
5. Phone Numbers: import the Twilio number with its account SID and auth token ([guide](https://elevenlabs.io/docs/agents-platform/phone-numbers/twilio-integration/native-integration)), and assign the Switchboard agent to it.
6. iPhone: add a contact named Switchboard with that number.

## Limits

- Messages from the call land in a session as a message from another session, not as KC typing. The session treats them as a colleague's request.
- A session in another permission mode holds the message for approval. The switchboard and the loop's agents run in auto mode. Other sessions start in the default mode of `config/settings.json`.
- Every call costs ElevenLabs agent minutes and Twilio minutes, and every turn costs Claude usage.
