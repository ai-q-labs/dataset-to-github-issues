import { Actor, log } from 'apify';

import { call, ConnectorError, openConnector, pickTool, visibleTools } from './mcp.js';
import { decide, issueBody, issueTitle, keyFromTitle, realCodes, unverifiedCodes } from './select.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    datasetId = '',
    githubConnector = '',
    owner = '',
    repo = '',
    minRiskLevel = 'high',
    maxIssues = 10,
    dryRun = true,
    labels = [],
} = input;

for (const [name, value] of [['datasetId', datasetId], ['owner', owner], ['repo', repo]]) {
    if (!String(value).trim()) await Actor.fail(`${name} is required and was empty.`);
}

const cap = Math.max(1, Math.min(50, Number(maxIssues) || 10));
const runUrl = process.env.APIFY_ACTOR_RUN_ID
    ? `https://console.apify.com/actors/runs/${process.env.APIFY_ACTOR_RUN_ID}`
    : null;

// --- 1. the findings ---------------------------------------------------------
let rows = [];
try {
    const dataset = await Actor.openDataset(String(datasetId).trim(), { forceCloud: true });
    const { items } = await dataset.getData({ limit: 1000 });
    rows = items ?? [];
} catch (err) {
    await Actor.fail(`Could not read dataset ${datasetId}: ${String(err?.message || err)}`);
}
if (!rows.length) await Actor.fail(`Dataset ${datasetId} is empty, so there is nothing to file.`);
log.info(`Read ${rows.length} row(s) from dataset ${datasetId}.`);

// --- 2. the connector --------------------------------------------------------
let client;
try {
    client = await openConnector(String(githubConnector).trim());
} catch (err) {
    if (err instanceof ConnectorError) await Actor.fail(err.message);
    throw err;
}

const tools = await visibleTools(client);
await Actor.setValue('TOOLS_VISIBLE_TO_THIS_ACTOR', {
    note: 'What the Apify MCP Proxy let this Actor see. The connector itself supports more; the '
        + 'input schema declaration is what narrows it to this.',
    count: tools.length,
    tools,
});
log.info(`The proxy exposes ${tools.length} tool(s) to this run: ${tools.map((t) => t.name).join(', ') || '(none)'}`);

const ALIASES = {
    owner: ['owner', 'repo_owner', 'organization'],
    repo: ['repo', 'repository', 'repo_name'],
    state: ['state', 'status'],
    perPage: ['perPage', 'per_page', 'limit', 'pageSize'],
    page: ['page'],
    title: ['title'],
    body: ['body', 'description'],
    labels: ['labels'],
    method: ['method', 'action', 'operation'],
};

/** Build a call payload out of only the argument names a tool actually declares. */
function argsFor(tool, wanted) {
    const props = new Set(tool.properties ?? []);
    const out = {};
    for (const [key, value] of Object.entries(wanted)) {
        if (value === undefined || value === null) continue;
        const target = (ALIASES[key] ?? [key]).find((a) => props.has(a));
        if (target) out[target] = value;
    }
    return out;
}

/**
 * Some servers fold several operations into one tool behind a `method` enum (issue_write does
 * create and update; issue_read does get and list). Pick the value that matches what we want,
 * or undefined if the tool has no such switch.
 */
function methodValue(tool, pattern) {
    const prop = tool.inputSchema?.properties?.method
        ?? tool.inputSchema?.properties?.action
        ?? tool.inputSchema?.properties?.operation;
    const values = prop?.enum;
    if (!Array.isArray(values)) return undefined;
    const exact = values.find((v) => new RegExp(`^${pattern.source}$`, 'i').test(String(v)));
    return exact ?? values.find((v) => pattern.test(String(v)));
}

/**
 * Find the issue this reply is about, without insisting on one field name. Servers differ:
 * some return the issue object, some wrap it, some only send back a sentence with the URL in
 * it. Falling back to the URL is not elegant, but a null issue number in the report is worse
 * than reading it out of a string, and the number is in the URL by construction.
 */
function findIssueRef(reply) {
    const out = { number: null, url: null };
    if (!reply) return out;
    if (typeof reply === 'object') {
        const o = reply.issue ?? reply.data ?? reply;
        const n = o?.number ?? o?.issue_number ?? o?.id;
        if (Number.isInteger(n)) out.number = n;
        const u = o?.html_url ?? o?.htmlUrl ?? o?.url;
        if (typeof u === 'string') out.url = u;
        if (out.number !== null && out.url !== null) return out;
    }
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
    const m = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/.exec(text);
    if (m) {
        out.url ??= m[0];
        if (out.number === null) out.number = Number(m[1]);
    }
    return out;
}

const readTool = pickTool(tools, ['list_issues', 'issue_read', 'search_issues']);
const writeTool = dryRun ? null : pickTool(tools, ['issue_write', 'create_issue']);

if (!readTool) {
    await Actor.fail(
        'No tool for reading issues is visible to this run. Looked for list_issues, issue_read, '
        + `search_issues; the proxy offered: ${tools.map((t) => t.name).join(', ') || '(none)'}. `
        + 'Without a read there is no way to avoid filing duplicates, so this run stops rather than '
        + 'writing blind.',
    );
}

// --- 3. read the tracker before writing to it --------------------------------
// This is the whole reason the connector fires here and not at the end: the decision of
// whether to open an issue depends on what is already open. A write-only integration would
// re-file every finding on every scheduled run.
const openKeys = new Set();
const seenTitles = [];
let readPages = 0;
let readError = null;
for (let page = 1; page <= 5; page += 1) {
    const res = await call(client, readTool.name, argsFor(readTool, {
        method: methodValue(readTool, /list/),
        owner,
        repo,
        state: 'open',
        perPage: 100,
        page,
    }));
    if (!res.ok) { readError = res.error; break; }
    readPages += 1;
    const list = Array.isArray(res.data) ? res.data : (res.data?.items ?? res.data?.issues ?? []);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const issue of list) {
        const title = issue?.title ?? issue?.name ?? '';
        seenTitles.push(title);
        const key = keyFromTitle(title);
        if (key) openKeys.add(key);
    }
    if (list.length < 100) break;
}

if (readError) {
    await Actor.fail(
        `Reading the existing issues failed: ${readError}. Stopping before any write, because `
        + 'without that list this run cannot tell a new finding from one it filed last time.',
    );
}
log.info(`${openKeys.size} finding(s) already have an open issue (read ${seenTitles.length} title(s) over ${readPages} page(s)).`);

// --- 4. decide ---------------------------------------------------------------
const decisions = rows.map((row) => {
    const d = decide(row, { minRiskLevel, openKeys });
    return {
        ...d,
        riskLevel: row?.riskLevel ?? null,
        issueCodes: Array.isArray(row?.issueCodes) ? row.issueCodes : [],
        verified: realCodes(row),
        unverified: unverifiedCodes(row),
        checkedAt: row?.checkedAt ?? null,
        row,
    };
});

const toFile = decisions.filter((d) => d.decision === 'file');
const deferred = toFile.slice(cap);
const filing = toFile.slice(0, cap);
for (const d of deferred) {
    d.decision = 'deferred';
    d.reason = `over the ${cap}-issue ceiling for this run`;
}

// --- 5. write ----------------------------------------------------------------
let created = 0;
if (dryRun) {
    for (const d of filing) {
        d.decision = 'would-file';
        d.issueTitle = issueTitle(d.row);
    }
    log.info(`Dry run: ${filing.length} issue(s) would be opened. Nothing was written.`);
} else if (!writeTool) {
    await Actor.fail(
        'No tool for opening an issue is visible to this run. Looked for issue_write, create_issue; '
        + `the proxy offered: ${tools.map((t) => t.name).join(', ') || '(none)'}.`,
    );
} else {
    const method = methodValue(writeTool, /create/);
    // Kept so the shape of a real reply is on record. A tool result is whatever the upstream
    // server decided to send; assuming a field name here and finding out in production that it
    // was called something else is exactly the failure this is meant to prevent.
    let firstReply = null;
    for (const d of filing) {
        const title = issueTitle(d.row);
        d.issueTitle = title;
        const res = await call(client, writeTool.name, argsFor(writeTool, {
            method,
            owner,
            repo,
            title,
            body: issueBody(d.row, { datasetId, runUrl }),
            labels: Array.isArray(labels) && labels.length ? labels : undefined,
        }));
        if (!res.ok) {
            d.decision = 'failed';
            d.reason = String(res.error).slice(0, 300);
            log.warning(`Could not open an issue for ${d.key}: ${d.reason}`);
            continue;
        }
        if (firstReply === null) firstReply = { text: String(res.text ?? '').slice(0, 2000), data: res.data ?? null };
        d.decision = 'filed';
        const found = findIssueRef(res.data) ?? findIssueRef(res.text);
        d.issueNumber = found.number;
        d.issueUrl = found.url;
        created += 1;
    }
    if (firstReply) await Actor.setValue('FIRST_WRITE_REPLY', firstReply);
    log.info(`Opened ${created} issue(s).`);
}

await client.close();

// --- 6. report ---------------------------------------------------------------
const counts = {};
for (const d of decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;

// The issues are already open by this point. A rejected dataset row must not turn a run that
// did its work into a FAILED run — that reads as "nothing happened", which is the opposite of
// the truth and would send the next run at the same findings.
const reportProblems = [];
for (const d of decisions) {
    const { row, verified, unverified, ...rest } = d;
    try {
        await Actor.pushData({ ...rest, verifiedCodes: verified, unverifiedCodes: unverified });
    } catch (err) {
        reportProblems.push({ key: d.key, error: String(err?.message || err).slice(0, 300) });
        log.warning(`Could not record the decision for ${d.key}: ${String(err?.message || err).slice(0, 200)}`);
    }
}
if (reportProblems.length) {
    log.warning(`${reportProblems.length} decision row(s) could not be written to the dataset. `
        + 'They are listed in SUMMARY.reportProblems. Any issue opened above is still open.');
}

const withheld = decisions.filter((d) => d.decision === 'withheld');
await Actor.setValue('SUMMARY', {
    datasetId,
    tracker: `${owner}/${repo}`,
    dryRun,
    minRiskLevel,
    maxIssues: cap,
    rowsRead: rows.length,
    openIssuesAlreadyPresent: openKeys.size,
    issuesOpened: created,
    counts,
    withheldBecauseUnverified: withheld.map((d) => ({ key: d.key, codes: d.unverified })),
    toolsVisible: tools.map((t) => t.name),
    reportProblems,
    generatedAt: new Date().toISOString(),
});

log.info(
    `Done. ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}. `
    + `${withheld.length} finding(s) were withheld because the audit could not verify them — they are in `
    + 'the dataset with decision=withheld, not in the tracker.',
);

await Actor.exit();
