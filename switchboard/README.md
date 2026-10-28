# Switchboard

A phone line to KC's Claude Code sessions. On CarPlay, KC says "Hey Siri, call Switchboard" and talks to one Claude Code session on the T14. That session lists the other sessions, reads how each one is doing, passes messages to them, and reads the replies back. It also grills, plans and triages on the call.

## How a call goes

```
iPhone (CarPlay) -> Twilio number -> ElevenLabs agent -> Tailscale Funnel :10000 -> switchboard :8796 -> claude -p
```

- ElevenLabs does the speech both ways. Its agent's LLM is a custom LLM: this server, which speaks the OpenAI chat completions API and streams Server-Sent Events.
- The server keeps one `claude -p` running in stream-json mode, named `switchboard`, in auto mode like the Remote Control sessions. Only the last thing KC said goes in, since the session already holds the conversation. It lives across calls, and a restart resumes it from the ID in `~/.local/state/switchboard/session`.
- Other sessions reach it with `SendMessage` to `switchboard`. A reply wakes it for a turn of its own. What it says then is read out at the start of KC's next turn on the call.
- When the session has said nothing after 4 seconds, the call hears "One moment." After 45 seconds it hears that the rest comes when KC asks, and the rest waits for the next turn.
- `src/switchboard/prompt.md` is what the session is told about the call: how to talk, what it may do, and what waits for a screen.

## Run it

`switchboard.service` in the machines repo runs it on the T14 from `~/dev/agent-workflow/switchboard`, and its `80-switchboard` script puts it on Tailscale Funnel at `https://t14.tail4fca58.ts.net:10000`. The token is `SWITCHBOARD_TOKEN` in `~/.config/switchboard/env`, and the same value is the API key secret in ElevenLabs.

Run `uv run pytest` here. The tests use a stand-in `claude` in `tests/bin`.

## Set up the phone side

Done once, by KC, in the two dashboards.

1. Twilio: make an account and buy a Canadian local number with voice. It costs [$1.15 a month](https://www.twilio.com/en-us/voice/pricing/ca), plus minutes.
2. ElevenLabs, Agents: create an agent named Switchboard. Set the first message to "Switchboard here.", and pick a voice.
3. In the agent's LLM setting, choose Custom LLM. Server URL: `https://t14.tail4fca58.ts.net:10000/v1`. Model ID: `switchboard`. API key: a new secret with the value of `SWITCHBOARD_TOKEN`. Publish.
4. Test it with the agent's test call in the browser. Ask "which of my sessions are busy?".
5. Phone Numbers: import the Twilio number with its account SID and auth token ([guide](https://elevenlabs.io/docs/agents-platform/phone-numbers/twilio-integration/native-integration)), and assign the Switchboard agent to it.
6. iPhone: add a contact named Switchboard with that number.

## Limits

- Messages from the call land in a session as a message from another session, not as KC typing. The session treats them as a colleague's request.
- A session in another permission mode holds the message for approval. Remote Control sessions run in auto mode, as the switchboard does.
- Every call costs ElevenLabs agent minutes and Twilio minutes, and every turn costs Claude usage.
