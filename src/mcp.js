/**
 * Talking to an MCP connector from inside an Actor.
 *
 * The Actor never sees the GitHub token. It authenticates to the Apify MCP Proxy with its
 * own run token, and the platform injects the connector's credential server-side. So the
 * bearer below is APIFY_TOKEN — deliberately, not by oversight.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class ConnectorError extends Error {}

export async function openConnector(connectorId, { name = 'dataset-to-github-issues', version = '0.1.0' } = {}) {
    const base = process.env.APIFY_MCP_PROXY_URL;
    const token = process.env.APIFY_TOKEN;
    if (!base) {
        throw new ConnectorError(
            'APIFY_MCP_PROXY_URL is not set. MCP connectors are only reachable from a run on the Apify '
            + 'platform; a local run has no proxy to talk to.',
        );
    }
    if (!token) throw new ConnectorError('APIFY_TOKEN is not set, so the proxy cannot authenticate this run.');
    if (!connectorId) throw new ConnectorError('No connector was given in the input.');

    const url = new URL(`${base.replace(/\/+$/, '')}/${connectorId}`);
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    const client = new Client({ name, version });
    try {
        await client.connect(transport);
    } catch (err) {
        throw new ConnectorError(
            `Could not reach the connector through the proxy: ${String(err?.message || err)}. `
            + 'Check that the connector is still authorized and that this Actor declares the tools it needs.',
        );
    }
    return client;
}

/**
 * What the proxy is willing to show us. This is not the same as what the connector supports:
 * the proxy filters the list down to the tools this Actor declared in its input schema.
 */
export async function visibleTools(client) {
    const { tools } = await client.listTools();
    return (tools ?? []).map((t) => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description.slice(0, 400) : null,
        annotations: t.annotations ?? null,
        required: t.inputSchema?.required ?? [],
        properties: Object.keys(t.inputSchema?.properties ?? {}),
        inputSchema: t.inputSchema ?? null,
    }));
}

/** Call a tool and hand back both the text and whatever structure came with it. */
export async function call(client, name, args) {
    let res;
    try {
        res = await client.callTool({ name, arguments: args });
    } catch (err) {
        return { ok: false, error: String(err?.message || err), text: null, data: null };
    }
    const text = (res?.content ?? [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('\n');
    let data = res?.structuredContent ?? null;
    if (data === null && text) {
        try { data = JSON.parse(text); } catch { /* not JSON; the text is the answer */ }
    }
    return { ok: !res?.isError, error: res?.isError ? text || 'the tool reported an error' : null, text, data };
}

/**
 * Pick the tool that does a job, by trying known names in order. Returns null rather than
 * guessing, so a caller can report exactly which names it looked for and what it saw.
 */
export function pickTool(tools, candidates) {
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const c of candidates) if (byName.has(c)) return byName.get(c);
    return null;
}
