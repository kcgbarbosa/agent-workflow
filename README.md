# agent-workflow

This repository is a Claude Code plugin marketplace.
It holds one plugin, `kc-skills`, which contains KC's agent skills.
Claude Code loads each skill as an invocable skill with the name `kc-skills:<skill>`.
You can also type the short name, `/<skill>`, when no other command uses that name.

## Layout

| Path                                           | Content                                    |
| ---------------------------------------------- | ------------------------------------------ |
| `.claude-plugin/marketplace.json`              | The marketplace catalog                    |
| `plugins/kc-skills/.claude-plugin/plugin.json` | The plugin manifest                        |
| `plugins/kc-skills/skills/<name>/SKILL.md`     | One skill, with its other files beside it  |
| `licenses/`                                    | The licenses of the upstream skill sources |

## Add the marketplace to a project

Add these keys to the `.claude/settings.json` file of the project, then commit the file.

```json
{
  "extraKnownMarketplaces": {
    "agent-workflow": {
      "source": {
        "source": "github",
        "repo": "kcgbarbosa/agent-workflow"
      }
    }
  },
  "enabledPlugins": {
    "kc-skills@agent-workflow": true
  }
}
```

Claude Code registers the marketplace after you accept the workspace trust dialog for the folder.
The plugin uses a relative-path source, so it loads from the marketplace copy.

This repository is private.
Each machine that reads it must have git access to it without a prompt.
For HTTPS, run `gh auth login` and then `gh auth setup-git`.
For SSH, load a key into `ssh-agent`.

A cloud session on claude.ai/code does not install plugins from a project `.claude/settings.json`.
Refer to [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup).

## Install on one machine

Run these commands in a shell:

```bash
claude plugin marketplace add kcgbarbosa/agent-workflow
claude plugin install kc-skills@agent-workflow
```

To get new commits, run `claude plugin marketplace update agent-workflow`, then `claude plugin update kc-skills@agent-workflow`.
The plugin has no `version`, so each new commit is a new version.

## Check the marketplace

Run this command from the repository root before you push:

```bash
claude plugin validate .
```

## Skills

The skills are copies. Do not edit them here. Change a skill at its source, then copy it again.

| Skill                           | Source                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ask-matt`                      | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/ask-matt`                      |
| `code-review`                   | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/code-review`                   |
| `codebase-design`               | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/codebase-design`               |
| `diagnosing-bugs`               | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/diagnosing-bugs`               |
| `domain-modeling`               | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/domain-modeling`               |
| `find-skills`                   | [vercel-labs/skills](https://github.com/vercel-labs/skills), `skills/find-skills`                             |
| `grill-me`                      | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/productivity/grill-me`                     |
| `grill-with-docs`               | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/grill-with-docs`               |
| `grilling`                      | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/productivity/grilling`                     |
| `handoff`                       | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/productivity/handoff`                      |
| `implement`                     | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/implement`                     |
| `improve-codebase-architecture` | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/improve-codebase-architecture` |
| `pr-template`                   | KC                                                                                                            |
| `prototype`                     | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/prototype`                     |
| `research`                      | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/research`                      |
| `resolving-merge-conflicts`     | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/resolving-merge-conflicts`     |
| `setup-matt-pocock-skills`      | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/setup-matt-pocock-skills`      |
| `tdd`                           | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/tdd`                           |
| `teach`                         | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/productivity/teach`                        |
| `to-spec`                       | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/to-spec`                       |
| `to-tickets`                    | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/to-tickets`                    |
| `triage`                        | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/triage`                        |
| `unslop`                        | KC's local copy. No upstream source is recorded                                                               |
| `wayfinder`                     | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/engineering/wayfinder`                     |
| `writing-great-skills`          | [mattpocock/skills](https://github.com/mattpocock/skills), `skills/productivity/writing-great-skills`         |

## Licenses

The `mattpocock/skills` content is under the MIT License, copyright Matt Pocock.
Refer to [`licenses/mattpocock-skills.LICENSE`](licenses/mattpocock-skills.LICENSE).

The `vercel-labs/skills` content is under the MIT License, copyright Vercel, Inc.
Refer to [`licenses/vercel-labs-skills.LICENSE`](licenses/vercel-labs-skills.LICENSE).
