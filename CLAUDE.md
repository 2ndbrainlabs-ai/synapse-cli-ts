@AGENTS.md

## Claude Code specifics

- Playbooks from `docs/playbooks/` are also available as skills: `/add-provider`, `/add-command`, `/add-tests`, `/security-audit`.
- `.claude/settings.json` denies reading `.env*`, key files and `~/.synapse` config. Don't work around it; if you need a value, ask the person you're working with.
- Personal overrides go in `CLAUDE.local.md` or `.claude/settings.local.json` (both gitignored). Never put personal preferences or internal links in this file: the repo is public.
