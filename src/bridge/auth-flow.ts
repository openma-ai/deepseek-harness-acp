/**
 * Browser login over ACP url elicitation.
 *
 * `authenticate` has no session, so the elicitation is request-scoped with the
 * inbound JSON-RPC id of the `authenticate` request (captured by
 * `RequestIdTracker`). The adapter starts the local auth page, hands its URL
 * to the client through `elicitation/create` `mode: "url"`, and keeps waiting
 * on the page — the saved key arrives through the page's own POST inside its
 * bounded timeout, never over ACP. `elicitation/complete` always closes the
 * flow client-side, whether the key landed or the flow failed.
 */

import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { LocalAuthPage } from "../auth-page.ts";
import type { JsonRpcId } from "./request-ids.ts";

/** The client declined or cancelled the url elicitation. */
export class AuthLoginCancelled extends Error {
    constructor() {
        super("browser login was cancelled by the client");
        this.name = "AuthLoginCancelled";
    }
}

export interface BrowserLoginDeps {
    createElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
    completeElicitation: (params: { elicitationId: string }) => Promise<void>;
    startPage: (options: { credentialName: string }) => Promise<LocalAuthPage>;
    openPage: (url: string) => void;
    saveCredential: (key: string) => Promise<void>;
    requestId: JsonRpcId | undefined;
    provider: string | undefined;
    elicitationId: string;
    logDebug: (line: string) => void;
}

export async function runBrowserLogin(deps: BrowserLoginDeps, credentialName: string): Promise<void> {
    if (deps.requestId === undefined) {
        // Defensive: the tap wires every inbound authenticate request, so a
        // missing id means the bridge was driven outside the stream.
        throw new Error("browser login needs the inbound authenticate request id");
    }
    const page = await deps.startPage({ credentialName });
    const directed = deps
        .createElicitation({
            mode: "url",
            requestId: deps.requestId,
            elicitationId: deps.elicitationId,
            url: page.url,
            message:
                `Save your API key for ${credentialName}. The page is served by dsh-acp at ${page.url}; ` +
                "if the URL is not reachable from your browser (SSH, container, or WSL), " +
                "forward the port or open it on the machine running dsh-acp.",
            _meta: {
                dsh: {
                    auth: {
                        credential: credentialName,
                        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
                    },
                },
            },
        })
        .then((response) => {
            if (response.action === "decline" || response.action === "cancel") {
                throw new AuthLoginCancelled();
            }
        });
    // A local opener is a convenience on desktops, never the only path: the
    // client already has the URL through elicitation, so a missing browser or
    // display must not fail the flow.
    try {
        deps.openPage(page.url);
    } catch (error: unknown) {
        deps.logDebug(`local page opener failed: ${String(error)}`);
    }
    try {
        // `directed` resolving only means the client surfaced the URL; the key
        // still arrives through the page's own bounded timeout. Waiting on
        // both (not racing them) makes a decline or cancel decisive even if a
        // stray submission already landed on the page, and the page timeout
        // bounds a client that never answers the elicitation at all.
        const [, key] = await Promise.all([directed, page.completed]);
        await deps.saveCredential(key);
    } finally {
        page.close();
        try {
            await deps.completeElicitation({ elicitationId: deps.elicitationId });
        } catch (error: unknown) {
            deps.logDebug(`elicitation/complete failed: ${String(error)}`);
        }
    }
}
