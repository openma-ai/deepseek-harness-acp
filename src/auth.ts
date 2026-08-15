/**
 * ACP authentication helpers shared by `dsh-acp login` and the stdio bridge.
 *
 * Three Agent Auth methods, matching the Codex `_meta` shapes:
 * 1. `api-key` (or `api-key:<provider>`) — `_meta["api-key"].apiKey`
 * 2. `browser` — adapter opens a localhost page; the secret never travels ACP
 * 3. `gateway` — `_meta.gateway` `{ baseUrl, headers, providerName? }`,
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

export type AdvertisedAuthMethod = ApiKeyAuthMethod | BrowserAuthMethod | GatewayAuthMethod;

export interface ClientAuthCapabilities {
    auth?: { _meta?: Record<string, unknown> };
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

export function isBrowserAuthMethod(methodId: string | undefined): boolean {
    return methodId === "browser";
}

export function isGatewayAuthMethod(methodId: string | undefined): boolean {
    return methodId === "gateway";
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
    if (shouldOfferLocalAuthPage(env)) methods.push(browserAuthMethod());
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

function browserAuthMethod(): BrowserAuthMethod {
    return {
        id: "browser",
        name: "Browser",
        description: "Open a local sign-in page to save an API key. The secret never travels over ACP.",
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
