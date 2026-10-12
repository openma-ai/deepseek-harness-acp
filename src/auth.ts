/**
 * ACP authentication helpers shared by `dsh-acp login` and the stdio bridge.
 *
 * Auth methods, matching the claude-agent-acp capability-gated shape and the
 * Codex/openma `_meta` conventions:
 * 1. `api-key` (or `api-key:<provider>`) — `_meta["api-key"].apiKey`
 * 2. `terminal-login` (`type: "terminal"`) — the client spawns `dsh-acp login`
 *    itself; advertised when the client declares `auth.terminal` or
 *    `_meta["terminal-auth"]`
 * 3. `browser` — adapter serves a localhost page and hands its URL to the
 *    client through ACP url elicitation; only offered when the client can see
 *    the URL (`elicitation.url`) so the flow is never silently local-only
 * 4. `gateway` — `_meta.gateway` `{ baseUrl, headers, providerName? }`,
 *    advertised only when the client opts in with
 *    `clientCapabilities.auth._meta.gateway === true`
 */

export interface ProviderRoute {
    id: string;
    name?: string;
}

export interface ApiKeyAuthMethod {
    id: string;
    name: string;
    description: string;
    _meta: { "api-key": { provider?: string } };
}

export interface BrowserAuthMethod {
    id: "browser";
    name: string;
    description: string;
}

export interface GatewayAuthMethod {
    id: "gateway";
    name: string;
    description: string;
    _meta: { gateway: { protocol: "openai"; restartRequired: "false" } };
}

export interface TerminalAuthMethod {
    type: "terminal";
    id: string;
    name: string;
    description: string;
    args: string[];
    env: Record<string, string>;
    _meta?: Record<string, unknown>;
}

export type AdvertisedAuthMethod = ApiKeyAuthMethod | TerminalAuthMethod | BrowserAuthMethod | GatewayAuthMethod;

export interface ClientAuthCapabilities {
    auth?: { terminal?: boolean; _meta?: Record<string, unknown> };
    elicitation?: { url?: unknown; form?: unknown } | null;
    _meta?: Record<string, unknown>;
}

const LOGIN_DESCRIPTION =
    "Save an API key to the harness credential store shared with the dsh Web UI";

export function parseLoginArgv(argv: string[]): { provider?: string; key?: string } {
    let provider: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === undefined) continue;
        if (arg === "--provider") {
            provider = argv[i + 1];
            i += 1;
            continue;
        }
        if (arg.startsWith("--provider=")) {
            provider = arg.slice("--provider=".length);
            continue;
        }
        rest.push(arg);
    }
    const key = rest[0];
    return {
        ...(provider && provider.length > 0 ? { provider } : {}),
        ...(key && key.length > 0 ? { key } : {}),
    };
}

export function isDeepseekRoute(provider: string | undefined): boolean {
    return provider === undefined || provider === "deepseek-official" || provider === "deepseek";
}

export function credentialEnvNames(provider: string | undefined): string[] {
    if (provider === undefined || isDeepseekRoute(provider)) return ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"];
    if (provider === "anthropic") return ["ANTHROPIC_API_KEY"];
    if (provider === "openai" || provider.startsWith("openai")) return ["OPENAI_API_KEY"];
    return [`${provider.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`];
}

export function primaryCredentialName(provider: string | undefined): string {
    return credentialEnvNames(provider)[0] ?? "DEEPSEEK_API_KEY";
}

export function providerFromAuthMethodId(methodId: string | undefined): string | undefined {
    if (!methodId) return undefined;
    for (const prefix of ["api-key:", "terminal-login:"]) {
        if (methodId.startsWith(prefix)) return methodId.slice(prefix.length);
    }
    return undefined;
}

export function apiKeyFromAuthenticate(params: {
    methodId?: string;
    _meta?: unknown;
}): { provider?: string; key?: string } {
    const meta = params._meta;
    const block =
        meta && typeof meta === "object" && !Array.isArray(meta)
            ? (meta as { "api-key"?: unknown })["api-key"]
            : undefined;
    const record = block && typeof block === "object" && !Array.isArray(block)
        ? (block as { apiKey?: unknown; provider?: unknown })
        : undefined;
    const key = typeof record?.apiKey === "string" ? record.apiKey.trim() : undefined;
    const providerFromMeta = typeof record?.provider === "string" ? record.provider : undefined;
    const provider = providerFromMeta || providerFromAuthMethodId(params.methodId);
    return {
        ...(provider && provider.length > 0 ? { provider } : {}),
        ...(key && key.length > 0 ? { key } : {}),
    };
}

export function gatewayFromAuthenticate(params: {
    methodId?: string;
    _meta?: unknown;
}): {
    baseUrl?: string;
    headers?: Record<string, string>;
    providerName?: string;
    key?: string;
} {
    const meta = params._meta;
    const block =
        meta && typeof meta === "object" && !Array.isArray(meta)
            ? (meta as { gateway?: unknown }).gateway
            : undefined;
    const record = block && typeof block === "object" && !Array.isArray(block)
        ? (block as { baseUrl?: unknown; headers?: unknown; providerName?: unknown })
        : undefined;
    const baseUrl = typeof record?.baseUrl === "string" ? record.baseUrl.trim() : undefined;
    const headers = stringRecord(record?.headers);
    const providerName = typeof record?.providerName === "string" ? record.providerName.trim() : undefined;
    const key = apiKeyFromHeaders(headers);
    return {
        ...(baseUrl && baseUrl.length > 0 ? { baseUrl } : {}),
        ...(headers ? { headers } : {}),
        ...(providerName && providerName.length > 0 ? { providerName } : {}),
        ...(key && key.length > 0 ? { key } : {}),
    };
}

export function isApiKeyAuthMethod(methodId: string | undefined): boolean {
    return methodId === "api-key" || (methodId?.startsWith("api-key:") ?? false);
}

export function isBrowserAuthMethod(methodId: string | undefined): boolean {
    return methodId === "browser";
}

export function isGatewayAuthMethod(methodId: string | undefined): boolean {
    return methodId === "gateway";
}

export const TERMINAL_AUTH_METHOD_ID = "terminal-login";

export function isTerminalAuthMethod(methodId: string | undefined): boolean {
    return methodId === TERMINAL_AUTH_METHOD_ID || (methodId?.startsWith(`${TERMINAL_AUTH_METHOD_ID}:`) ?? false);
}

/**
 * `auth.terminal` (spec) or Zed's `_meta["terminal-auth"]` either one
 * advertises the terminal login method; only the meta flag also fills the
 * method's `_meta["terminal-auth"]` launch spec.
 */
export function clientSupportsTerminalAuth(caps: ClientAuthCapabilities | undefined | null): boolean {
    return caps?.auth?.terminal === true || caps?._meta?.["terminal-auth"] === true;
}

/** Whether the client can be handed a login URL through `elicitation/create` `mode: "url"`. */
export function clientSupportsUrlElicitation(caps: ClientAuthCapabilities | undefined | null): boolean {
    const elicitation = caps?.elicitation;
    if (elicitation === undefined || elicitation === null) return false;
    return elicitation.url !== undefined && elicitation.url !== null;
}

/**
 * The command a `_meta["terminal-auth"]` launch spec should run. The ACP
 * terminal method itself stays command-agnostic — the client appends `args`
 * to its own configured agent command — so the spec is only an optional
 * convenience for clients that launch the spec verbatim.
 */
export function terminalLaunchSpec(args: string[]): { command: string; args: string[] } {
    const argv0 = process.argv[0] ?? "node";
    const argv1 = process.argv[1];
    if (argv1 !== undefined && /node/.test(argv0) && /\.(m?js|ts)$/.test(argv1)) {
        return { command: argv0, args: [argv1, ...args] };
    }
    return { command: "dsh-acp", args };
}

export function credentialBaseUrlName(provider: string | undefined): string {
    if (isDeepseekRoute(provider) || provider === undefined) return "DEEPSEEK_BASE_URL";
    if (provider === "anthropic") return "ANTHROPIC_BASE_URL";
    if (provider === "openai" || provider.startsWith("openai")) return "OPENAI_BASE_URL";
    return `${provider.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_BASE_URL`;
}

export function advertisedAuthMethods(
    providers: readonly ProviderRoute[],
    clientCapabilities?: ClientAuthCapabilities | null,
    env: NodeJS.ProcessEnv = process.env,
): AdvertisedAuthMethod[] {
    const methods: AdvertisedAuthMethod[] = [...apiKeyAuthMethods(providers)];
    if (clientSupportsTerminalAuth(clientCapabilities)) methods.push(terminalAuthMethod(clientCapabilities));
    // Browser login only when the client can see the page URL (ACP url
    // elicitation): xdg-open alone leaves headless/SSH/WSL clients blind.
    if (clientSupportsUrlElicitation(clientCapabilities) && shouldOfferLocalAuthPage(env)) {
        methods.push(browserAuthMethod());
    }
    if (clientCapabilities?.auth?._meta?.["gateway"] === true) methods.push(gatewayAuthMethod());
    return methods;
}

export function apiKeyAuthMethods(providers: readonly ProviderRoute[]): ApiKeyAuthMethod[] {
    if (providers.length <= 1) {
        const provider = providers[0];
        return [apiKeyAuthMethod(provider?.id, provider?.name, providers.length === 0)];
    }
    return providers.map((provider) => apiKeyAuthMethod(provider.id, provider.name, false));
}

function apiKeyAuthMethod(
    provider: string | undefined,
    name: string | undefined,
    unscoped: boolean,
): ApiKeyAuthMethod {
    const scoped = !unscoped && provider !== undefined;
    return {
        id: scoped ? `api-key:${provider}` : "api-key",
        name: scoped ? `${name ?? provider} API key` : "API Key",
        description: LOGIN_DESCRIPTION,
        _meta: { "api-key": scoped ? { provider } : {} },
    };
}

export function shouldOfferLocalAuthPage(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env["NO_BROWSER"]) return false;
    if (env["NODE_ENV"] === "test" || env["CI"] === "true" || env["CI"] === "1") return false;
    if (env["DSH_ACP_AUTH_PAGE"] === "0") return false;
    return true;
}

function terminalAuthMethod(clientCapabilities: ClientAuthCapabilities | undefined | null): TerminalAuthMethod {
    const method: TerminalAuthMethod = {
        type: "terminal",
        id: TERMINAL_AUTH_METHOD_ID,
        name: "Log in with dsh-acp",
        description: "Run `dsh-acp login` in a terminal to save an API key to the harness credential store",
        args: ["login"],
        env: {},
    };
    // Zed's `_meta["terminal-auth"]` contract adds a runnable launch spec;
    // clients of plain `auth.terminal` spawn `dsh-acp login` themselves.
    if (clientCapabilities?._meta?.["terminal-auth"] === true) {
        method._meta = { "terminal-auth": { ...terminalLaunchSpec(["login"]), label: "dsh-acp login" } };
    }
    return method;
}

function browserAuthMethod(): BrowserAuthMethod {
    return {
        id: "browser",
        name: "Browser",
        description: "Save an API key through a local sign-in page whose URL is handed to the client. The secret never travels over ACP.",
    };
}

function gatewayAuthMethod(): GatewayAuthMethod {
    return {
        id: "gateway",
        name: "Custom model gateway",
        description: "Use a custom OpenAI-compatible gateway",
        _meta: { gateway: { protocol: "openai", restartRequired: "false" } },
    };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function apiKeyFromHeaders(headers: Record<string, string> | undefined): string | undefined {
    if (!headers) return undefined;
    const authorization = headers["Authorization"] ?? headers["authorization"];
    if (authorization) {
        const bearer = authorization.match(/^Bearer\s+(.+)$/i);
        const token = (bearer?.[1] ?? authorization).trim();
        if (token.length > 0) return token;
    }
    const first = Object.values(headers).find((value) => value.trim().length > 0);
    return first?.trim();
}

const AUTH_FAILURE_PATTERNS = [
    "authentication required",
    "authentication fails",
    "authentication failed",
    "invalid api key",
    "api key",
    "apikey",
    "unauthorized",
    "no api key",
    "no credential",
    "401",
    "403",
];

/**
 * Heuristic: does a provider/harness error message mean the user must
 * (re)authenticate? Turn failures that match are re-cast as ACP
 * auth_required (-32000) so clients can open their auth UI instead of
 * surfacing a bare internal error (openma-ai/Martty#160).
 */
export function looksLikeAuthFailure(message: string): boolean {
    const lower = message.toLowerCase();
    return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}
