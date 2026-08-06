/**
 * Deciding what deserves an issue.
 *
 * The audit this reads from answers in three states, not two: it found a defect, it
 * found nothing wrong, or it could not check. Only the first belongs in a tracker.
 * Filing the third turns "I don't know" into an alarm; dropping it silently turns an
 * unanswered question into a clean bill of health. So it gets its own decision and
 * stays in the output.
 *
 * Everything here is pure. The MCP side of the run is in mcp.js.
 */

const RANK = { critical: 4, high: 3, medium: 2, low: 1, ok: 0 };

/** Codes that mean "the check did not run", as opposed to "the check found something". */
export const UNVERIFIED_CODES = new Set(['not_checked']);

export const MARKER = 'dep-drift';

/** A stable identity for a finding, so a second run recognises its own first run. */
export function findingKey(row) {
    const name = row?.packageName || row?.requestedRepo || row?.input || null;
    if (!name) return null;
    const scope = row?.registry || (row?.requestedRepo ? 'repo' : null) || 'unknown';
    return `${scope}:${String(name).toLowerCase()}`;
}

export function issueTitle(row) {
    const key = findingKey(row);
    const codes = realCodes(row);
    const lead = codes[0] ? codes[0].replace(/_/g, ' ') : 'dependency drift';
    return `[${MARKER}] ${key} — ${lead}`;
}

/** Issue codes that represent an actual finding. */
export function realCodes(row) {
    const codes = Array.isArray(row?.issueCodes) ? row.issueCodes : [];
    return codes.filter((c) => !UNVERIFIED_CODES.has(c));
}

/** Issue codes that represent a check that could not run. */
export function unverifiedCodes(row) {
    const codes = Array.isArray(row?.issueCodes) ? row.issueCodes : [];
    return codes.filter((c) => UNVERIFIED_CODES.has(c));
}

/**
 * Turn one audit row into a decision. `openKeys` is the set of finding keys that already
 * have an open issue in the tracker — read from GitHub before any of this runs.
 */
export function decide(row, { minRiskLevel = 'high', openKeys = new Set() } = {}) {
    const key = findingKey(row);
    const risk = typeof row?.riskLevel === 'string' ? row.riskLevel : null;

    if (!key || !risk || !(risk in RANK)) {
        return { decision: 'unreadable', reason: 'row has no riskLevel or nothing to identify it by', key };
    }

    const real = realCodes(row);
    const unverified = unverifiedCodes(row);

    // "Could not check" never becomes an issue, at any threshold. It is reported here so
    // that a caller reading only the filed issues can still see it was set aside.
    if (real.length === 0) {
        if (unverified.length) {
            return { decision: 'withheld', reason: `not verified (${unverified.join(', ')})`, key };
        }
        return { decision: 'skipped', reason: 'nothing to report', key };
    }

    if (RANK[risk] < RANK[minRiskLevel]) {
        return { decision: 'skipped', reason: `below ${minRiskLevel}`, key };
    }

    if (openKeys.has(key)) {
        return { decision: 'skipped', reason: 'an open issue already covers this', key };
    }

    return { decision: 'file', reason: `${risk}: ${real.join(', ')}`, key };
}

/** The issue body. Anything the audit could not check is stated, not omitted. */
export function issueBody(row, { datasetId, runUrl } = {}) {
    const lines = [];
    const real = realCodes(row);
    const unverified = unverifiedCodes(row);

    lines.push(`**${findingKey(row)}** — risk: \`${row.riskLevel}\``);
    lines.push('');

    const details = Array.isArray(row?.issues) ? row.issues : [];
    const found = details.filter((d) => !UNVERIFIED_CODES.has(d?.code));
    if (found.length) {
        lines.push('### What the audit found');
        for (const d of found) lines.push(`- \`${d.code}\` (${d.severity ?? 'unknown'}) — ${d.detail ?? ''}`.trimEnd());
        lines.push('');
    } else if (real.length) {
        lines.push('### What the audit found');
        for (const c of real) lines.push(`- \`${c}\``);
        lines.push('');
    }

    if (unverified.length) {
        lines.push('### What the audit could not check');
        const notes = details.filter((d) => UNVERIFIED_CODES.has(d?.code));
        if (notes.length) for (const d of notes) lines.push(`- \`${d.code}\` — ${d.detail ?? ''}`.trimEnd());
        else for (const c of unverified) lines.push(`- \`${c}\``);
        lines.push('');
        lines.push('These are open questions, not clean results. Re-run the audit to close them.');
        lines.push('');
    }

    const facts = [
        ['declared', row?.declaredSpec],
        ['registry', row?.registry],
        ['repository', row?.requestedRepo],
        ['checked at', row?.checkedAt],
    ].filter(([, v]) => v);
    if (facts.length) {
        lines.push('### Details');
        for (const [k, v] of facts) lines.push(`- ${k}: \`${v}\``);
        lines.push('');
    }

    lines.push('---');
    lines.push(
        `Opened automatically from audit dataset \`${datasetId ?? 'unknown'}\``
        + `${runUrl ? ` ([run](${runUrl}))` : ''}. The \`[${MARKER}]\` tag in the title is how a later run `
        + 'recognises this issue and does not file it again — please keep it.',
    );
    return lines.join('\n');
}

/** Pull the finding key back out of an existing issue title. Null if it is not ours. */
export function keyFromTitle(title) {
    const m = /^\[dep-drift\]\s+([^\s—]+)/.exec(String(title ?? '').trim());
    return m ? m[1] : null;
}
