import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    decide, findingKey, issueBody, issueTitle, keyFromTitle, realCodes, unverifiedCodes,
} from '../src/select.js';

const confirmed = {
    packageName: 'request',
    registry: 'npm',
    requestedRepo: 'request/request',
    declaredSpec: '^2.88.0',
    riskLevel: 'high',
    issueCodes: ['silent_abandonment'],
    issues: [{ code: 'silent_abandonment', severity: 'high', detail: 'Repository archived 2020-05-11; npm still serves it with no deprecation notice.' }],
    checkedAt: '2026-08-06T05:00:00.000Z',
};

const unverifiedOnly = {
    packageName: 'left-pad',
    registry: 'npm',
    riskLevel: 'low',
    issueCodes: ['not_checked'],
    issues: [{ code: 'not_checked', severity: 'low', detail: "GitHub's hourly allowance ran out." }],
};

const mixed = {
    packageName: 'colors',
    registry: 'npm',
    riskLevel: 'critical',
    issueCodes: ['license_changed', 'not_checked'],
    issues: [
        { code: 'license_changed', severity: 'critical', detail: 'MIT at install time, now unlicensed.' },
        { code: 'not_checked', severity: 'low', detail: 'Contributor check did not run.' },
    ],
};

test('a finding key is stable and lowercased', () => {
    assert.equal(findingKey(confirmed), 'npm:request');
    assert.equal(findingKey({ requestedRepo: 'Foo/Bar' }), 'repo:foo/bar');
    assert.equal(findingKey({}), null);
});

test('the title carries the marker and round-trips back to the key', () => {
    const title = issueTitle(confirmed);
    assert.match(title, /^\[dep-drift\] npm:request — silent abandonment$/);
    assert.equal(keyFromTitle(title), 'npm:request');
    assert.equal(keyFromTitle('Unrelated issue about docs'), null);
});

test('not_checked is separated from real findings', () => {
    assert.deepEqual(realCodes(mixed), ['license_changed']);
    assert.deepEqual(unverifiedCodes(mixed), ['not_checked']);
    assert.deepEqual(realCodes(unverifiedOnly), []);
});

test('a confirmed finding at or above the threshold is filed', () => {
    const d = decide(confirmed, { minRiskLevel: 'high' });
    assert.equal(d.decision, 'file');
    assert.equal(d.key, 'npm:request');
});

test('a confirmed finding below the threshold is skipped, not withheld', () => {
    const d = decide(confirmed, { minRiskLevel: 'critical' });
    assert.equal(d.decision, 'skipped');
    assert.match(d.reason, /below critical/);
});

test('a row whose only finding is not_checked is never filed, at any threshold', () => {
    for (const level of ['critical', 'high', 'medium']) {
        const d = decide(unverifiedOnly, { minRiskLevel: level });
        assert.equal(d.decision, 'withheld', `threshold ${level}`);
        assert.match(d.reason, /not verified/);
    }
});

test('a row with both a real finding and an unchecked one is still filed', () => {
    const d = decide(mixed, { minRiskLevel: 'high' });
    assert.equal(d.decision, 'file');
});

test('a finding that already has an open issue is skipped', () => {
    const d = decide(confirmed, { minRiskLevel: 'high', openKeys: new Set(['npm:request']) });
    assert.equal(d.decision, 'skipped');
    assert.match(d.reason, /already covers this/);
});

test('a row the audit did not shape properly is called unreadable, not clean', () => {
    assert.equal(decide({ packageName: 'x' }).decision, 'unreadable');
    assert.equal(decide({ riskLevel: 'high' }).decision, 'unreadable');
    assert.equal(decide({ packageName: 'x', registry: 'npm', riskLevel: 'nonsense' }).decision, 'unreadable');
});

test('a clean row is skipped with nothing to report', () => {
    const d = decide({ packageName: 'ok-pkg', registry: 'npm', riskLevel: 'ok', issueCodes: [] });
    assert.equal(d.decision, 'skipped');
    assert.equal(d.reason, 'nothing to report');
});

test('the body states what could not be checked instead of omitting it', () => {
    const body = issueBody(mixed, { datasetId: 'ds123' });
    assert.match(body, /What the audit found/);
    assert.match(body, /license_changed/);
    assert.match(body, /What the audit could not check/);
    assert.match(body, /Contributor check did not run/);
    assert.match(body, /open questions, not clean results/);
    assert.match(body, /ds123/);
});

test('a body with no unchecked codes omits that section entirely', () => {
    const body = issueBody(confirmed, { datasetId: 'ds123' });
    assert.doesNotMatch(body, /could not check/);
});
