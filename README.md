# GitHub Issue Writer: File Audit Findings, Skip Duplicates

An audit run ends with a dataset. A dataset is a place findings go to be correct in private.

This Actor takes that dataset and opens a GitHub issue for each confirmed finding, through an
[Apify MCP connector](https://docs.apify.com/platform/integrations/mcp-connectors). It reads the
tracker before it writes anything, so running it again does not file the same finding twice.

It was built to sit downstream of [`github-repository-audit`](https://apify.com/aiqlabs/github-repository-audit),
but nothing about that Actor is hard-coded here. Any dataset whose rows carry `riskLevel` and
`issueCodes` works.

## What it does with a finding

The audit it reads from answers in three states, not two:

| State | What it means | What happens here |
|---|---|---|
| Found something | A check ran and failed | An issue is opened, if it is at or above your risk threshold |
| Found nothing | A check ran and passed | Skipped |
| Could not check | The check never ran (a rate limit, a network error) | **Never filed on its own**, and never dropped silently |

The third state is the reason this Actor exists in the shape it does. Filing it turns "I don't know"
into an alarm. Dropping it turns an unanswered question into a clean bill of health.

So a row whose only content is an unverified check comes back as `withheld`, and a row that has both
a real finding and an unverified check carries the caveat into the issue body:

```markdown
### What the audit found
- `deprecated_on_registry` (high) — The registry marks this deprecated: "Package no longer supported..."

### What the audit could not check
- `not_checked` — aceakash/string-similarity was not checked: GitHub's hourly allowance ran out.

These are open questions, not clean results. Re-run the audit to close them.
```

## Deduplication, without a state file

Every issue is titled `[dep-drift] <key> — <lead finding>`. A later run lists the open issues, parses
the key back out of titles it wrote itself, and skips anything already covered. There is no state
file and nothing to fall out of sync with the tracker.

If the read fails, the run stops before writing. Duplicates in someone's tracker cost more than a
failed run.

## Setting up the connector

1. In Apify Console, open **Integrations → MCP connectors → Add new MCP connector**.
2. GitHub is not one of the presets. Type the server URL directly:
   `https://api.githubcopilot.com/mcp/`
3. Console probes the server and offers **API key**. Paste a GitHub
   [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
   scoped to the tracker repository with **Issues: read and write**. Nothing else is needed.
4. **Check the server URL again immediately before you press Save.** In my setup it silently reverted
   to the first preset in the list while I was pasting the key, with a green validation check still
   showing.

The Actor never sees that token. It authenticates to the Apify MCP Proxy with its own run token, and
the platform injects the credential server-side.

### Why it can only touch issues

The connector discovers whatever the server supports — 44 tools, in my case, including
`create_repository`, `delete_file` and `merge_pull_request`. This Actor declares four of them in its
input schema:

```json
"mcpServers": [
    {
        "url": "https://api.githubcopilot.com/mcp/",
        "tools": { "required": ["issue_read", "issue_write", "list_issues", "search_issues"] }
    }
]
```

The proxy enforces that declaration. A run of this Actor sees four tools and cannot call a fifth,
whatever the connector or the token would otherwise allow. The run log states the number it got:

```text
INFO  The proxy exposes 4 tool(s) to this run: issue_read, issue_write, list_issues, search_issues
```

## Input

| Field | Required | What it is |
|---|---|---|
| `datasetId` | ✓ | The audit dataset. Read access only, declared in the schema — this Actor never writes back into your audit results |
| `githubConnector` | ✓ | An MCP connector authorized against GitHub |
| `owner` / `repo` | ✓ | The tracker the issues go into. This is not the audited project |
| `minRiskLevel` | | `critical`, `high` (default) or `medium` and above |
| `maxIssues` | | Ceiling on writes per run, default 10. Findings past it are reported as `deferred`, not dropped |
| `dryRun` | | **On by default.** Reads the tracker, decides, reports, writes nothing |
| `labels` | | Applied only if the label already exists; this Actor does not create labels |

Leave `dryRun` on for the first run against a repository you care about.

## Output

One dataset row per audit row, with the decision (`file` / `filed` / `skipped` / `deferred` /
`withheld` / `unreadable`), the reason in plain English, and the issue number and URL for anything
filed. Plus two key-value records:

- `SUMMARY` — counts, the tools the proxy exposed, and anything that could not be recorded
- `TOOLS_VISIBLE_TO_THIS_ACTOR` — the full schema of every tool the run could actually see

## Honest limits

- **`withheld` has never fired on live data.** It has unit tests and it is correct as written, but in
  178 audited packages every unverified row also carried a real finding. The whole-row case is rarer
  than I assumed when I built it.
- **The issue number comes out of the URL.** `issue_write` replies with `{"id": "...", "url": "..."}`
  and no `number` field, and that `id` is an internal identifier, not the issue number. This Actor
  parses the URL rather than recording a plausible wrong number.
- **A failed dataset write does not fail the run.** By the time the report is written the issues are
  already open, and a FAILED run reads as "nothing happened". Problems are listed in
  `SUMMARY.reportProblems` instead.

## Running it locally

Local runs cannot reach MCP connectors; `APIFY_MCP_PROXY_URL` only exists in a platform run. Unit
tests run anywhere:

```bash
npm install
npm test
```

## License

ISC. See [LICENSE](LICENSE).
