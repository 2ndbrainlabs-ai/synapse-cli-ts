# Issue tracker: Jira

Issues and specs for this repo live in Jira: site `https://2ndbrainlabs.atlassian.net/`, project key **`SYN`**. Use the Atlassian CLI (`acli`) for every operation. Don't use GitHub Issues for this repo; it is empty.

## Setup

- Install: `brew tap atlassian/homebrew-acli && brew install acli` (verified against `acli` 1.3.39)
- Authenticate once, either in the browser (`acli jira auth login --web`) or with an API token read from stdin (`acli jira auth login --site 2ndbrainlabs.atlassian.net --email <you> --token < token.txt`). Create tokens at https://id.atlassian.com/manage-profile/security/api-tokens.
- Check: `acli jira auth status`

If `acli` is missing or unauthenticated, stop and ask the user. Don't fall back to another tracker. If a flag below is rejected, run `acli jira workitem <subcommand> --help`; `acli` is still changing.

Always pass `--yes` to `edit`, `transition`, `assign` and `link create`. Without it they wait for an interactive confirmation and the agent hangs.

## Conventions

- **Work item types** (the ones SYN uses): `Task` by default, `Bug` for defects, `Story` for user-facing features, `Spike` for time-boxed research, `Epic` for a spec that breaks down into several tickets, and `Subtask` for small pieces of one Task.
- **Statuses**: `To Do` → `In Progress` → `Test/Review` → `Done`. Move a ticket to `Test/Review` when its PR is open, and to `Done` when it merges.
- **Keys**: always write items as `SYN-<n>`. Branches are named `SYN-<n>` (existing convention, e.g. `SYN-49`), and PR titles start with the key (`SYN-49: …`) so Jira links them.
- **Create**: `acli jira workitem create --project SYN --type Task --summary "..." --description "..." --json`. For long bodies, write the description to a temp file and pass `--description-file <path>`. Add `--parent SYN-<epic>` to put the item under an epic, and `--label "a,b"` to set labels.
- **Read**: `acli jira workitem view SYN-<n> --fields "*all" --json` (includes description, labels, status, and comments). For the full comment thread, use `acli jira workitem comment list --key SYN-<n> --json --paginate`.
- **List / search**: `acli jira workitem search --jql 'project = SYN AND statusCategory != Done ORDER BY created DESC' --fields "key,issuetype,summary,status,labels,assignee" --json`. Add `AND labels = "<label>"` to filter by triage label, or `--paginate` to fetch everything. `--fields` rejects some fields, including `parent`. Filter on them in the JQL (`parent = SYN-<n>`) or read them with `view`.
- **Comment**: `acli jira workitem comment create --key SYN-<n> --body "..."`. For multi-line comments, use `--body-file <path>`.
- **Apply / remove labels**: `acli jira workitem edit --key SYN-<n> --labels "<label>" --yes` / `acli jira workitem edit --key SYN-<n> --remove-labels "<label>" --yes`
- **Transition**: `acli jira workitem transition --key SYN-<n> --status "In Progress" --yes` (or `"Done"`). Workflow statuses are Jira's, not labels. Triage roles are labels (see `triage-labels.md`).
- **Close**: post the reason as a comment first, then transition to `Done`. For won't-do items, also apply the `wontfix` label.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` to treat external GitHub PRs as feature requests; `/triage` reads this flag.)_ PRs live on GitHub (`gh pr ...`), and issues live in Jira.

## When a skill says "publish to the issue tracker"

Create a `SYN` work item with `acli jira workitem create` and report its key and URL (`https://2ndbrainlabs.atlassian.net/browse/SYN-<n>`).

## When a skill says "fetch the relevant ticket"

Run `acli jira workitem view SYN-<n> --fields "*all" --json`. If the user gives a bare number, treat it as `SYN-<n>`. If you're on a `SYN-<n>` branch, that is the ticket.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an Epic, and each **child** ticket sits under it.

- **Map**: an `Epic` labelled `wayfinder-map`, whose description holds the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a `Task` (or a `Spike` for research) created with `--parent SYN-<map>` and labelled `wayfinder-<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: Jira's native "Blocks" issue link: `acli jira workitem link create --out SYN-<blocker> --in SYN-<child> --type Blocks --yes`. List a ticket's links with `acli jira workitem link list --key SYN-<n> --json`. A ticket is unblocked when every blocker's status category is Done.
- **Frontier query**: `acli jira workitem search --jql 'parent = SYN-<map> AND statusCategory != Done AND assignee is EMPTY ORDER BY rank'`. Drop any result with an open "is blocked by" link. The first remaining result wins.
- **Claim**: `acli jira workitem assign --key SYN-<n> --assignee "@me" --yes`. This must be the session's first write.
- **Resolve**: comment the answer, transition to `Done`, then append a context pointer (gist + key) to the map's Decisions-so-far.
