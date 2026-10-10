import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    advertisedAuthMethods,
    apiKeyAuthMethods,
    apiKeyFromAuthenticate,
    clientSupportsTerminalAuth,
    clientSupportsUrlElicitation,
    credentialBaseUrlName,
    credentialEnvNames,
    gatewayFromAuthenticate,
    isApiKeyAuthMethod,
    isTerminalAuthMethod,
    parseLoginArgv,
    providerFromAuthMethodId,
    terminalLaunchSpec,
} from "../src/auth.ts";

describe("ACP Agent Auth advertisement", () => {
    it("advertises an agent API-key method, not Terminal Auth", () => {
        expect(apiKeyAuthMethods([])).toEqual([
            {
                id: "api-key",
                name: "API Key",
                description:
                    "Save an API key to the harness credential store shared with the dsh Web UI",
                _meta: { "api-key": {} },
            },
        ]);
    });

    it("advertises one API-key method per provider route", () => {
        expect(
            apiKeyAuthMethods([
                { id: "deepseek-official", name: "DeepSeek" },
                { id: "anthropic", name: "Anthropic" },
            ]),
        ).toEqual([
            {
                id: "api-key:deepseek-official",
                name: "DeepSeek API key",
                description:
                    "Save an API key to the harness credential store shared with the dsh Web UI",
                _meta: { "api-key": { provider: "deepseek-official" } },
            },
            {
                id: "api-key:anthropic",
                name: "Anthropic API key",
                description:
                    "Save an API key to the harness credential store shared with the dsh Web UI",
                _meta: { "api-key": { provider: "anthropic" } },
            },
        ]);
    });

    it("adds terminal, browser and gateway only when the client can use them", () => {
        expect(advertisedAuthMethods([], undefined, { NODE_ENV: "test" }).map((method) => method.id))
            .toEqual(["api-key"]);
        expect(
            advertisedAuthMethods([], { auth: { _meta: { gateway: true } } }, { NODE_ENV: "test" })
                .map((method) => method.id),
        ).toEqual(["api-key", "gateway"]);
        // Browser login is never local-only: without url elicitation the
        // method is not offered, even on a desktop-like environment.
        expect(advertisedAuthMethods([], undefined, { NODE_ENV: "production" }).map((method) => method.id))
            .toEqual(["api-key"]);
        expect(
            advertisedAuthMethods([], { elicitation: { url: {} } }, { NODE_ENV: "production" })
                .map((method) => method.id),
        ).toEqual(["api-key", "browser"]);
        expect(
            advertisedAuthMethods([], { auth: { terminal: true } }, { NODE_ENV: "production" })
                .map((method) => method.id),
        ).toEqual(["api-key", "terminal-login"]);
        expect(
            advertisedAuthMethods(
                [],
                { auth: { terminal: true, _meta: { gateway: true } }, elicitation: { url: {} } },
                { NODE_ENV: "production" },
            ).map((method) => method.id),
        ).toEqual(["api-key", "terminal-login", "browser", "gateway"]);
        expect(
            advertisedAuthMethods(
                [],
                { auth: { _meta: { gateway: true } }, elicitation: { url: {} } },
                { NODE_ENV: "production", NO_BROWSER: "1" },
            ).map((method) => method.id),
        ).toEqual(["api-key", "gateway"]);
    });

    it("advertises a spec terminal method the client runs under its own command", () => {
        const [method] = advertisedAuthMethods(
            [],
            { auth: { terminal: true } },
            { NODE_ENV: "test" },
        ).filter((candidate) => "type" in candidate && candidate.type === "terminal");
        expect(method).toEqual({
            type: "terminal",
            id: "terminal-login",
            name: "Log in with dsh-acp",
            description: expect.stringContaining("dsh-acp login"),
            args: ["login"],
            env: {},
        });
    });

    it("adds the Zed terminal-auth launch spec only when the client asks for it", () => {
        const withSpec = advertisedAuthMethods(
            [],
            { _meta: { "terminal-auth": true } },
            { NODE_ENV: "test" },
        ).find((method) => method.id === "terminal-login");
        expect(withSpec).toBeDefined();
        const spec = (
            withSpec as { _meta?: Record<string, { command: string; args: string[]; label: string }> } | undefined
        )?._meta?.["terminal-auth"];
        expect(spec).toBeDefined();
        expect(spec?.label).toBe("dsh-acp login");
        expect(spec?.args.at(-1)).toBe("login");
    });

    it("keeps per-provider api-key methods in front of the shared methods", () => {
        expect(
            advertisedAuthMethods(
                [
                    { id: "deepseek-official", name: "DeepSeek" },
                    { id: "anthropic", name: "Anthropic" },
                ],
                {
                    auth: { terminal: true, _meta: { gateway: true } },
                    elicitation: { url: {} },
                },
                { NODE_ENV: "production" },
            ).map((method) => method.id),
        ).toEqual([
            "api-key:deepseek-official",
            "api-key:anthropic",
            "terminal-login",
            "browser",
            "gateway",
        ]);
    });

    it("advertises Codex-shaped gateway metadata", () => {
        expect(
            advertisedAuthMethods([], { auth: { _meta: { gateway: true } } }, { NODE_ENV: "test" })
                .find((method) => method.id === "gateway"),
        ).toEqual({
            id: "gateway",
            name: "Custom model gateway",
            description: "Use a custom OpenAI-compatible gateway",
            _meta: { gateway: { protocol: "openai", restartRequired: "false" } },
        });
    });
});

describe("authenticate _meta and login argv", () => {
    it("reads the API key from authenticate _meta", () => {
        expect(apiKeyFromAuthenticate({ methodId: "api-key" })).toEqual({});
        expect(
            apiKeyFromAuthenticate({
                methodId: "api-key:anthropic",
                _meta: { "api-key": { apiKey: "sk-ant", provider: "anthropic" } },
            }),
        ).toEqual({ key: "sk-ant", provider: "anthropic" });
    });

    it("reads gateway settings from authenticate _meta", () => {
        expect(gatewayFromAuthenticate({ methodId: "gateway" })).toEqual({});
        expect(
            gatewayFromAuthenticate({
                methodId: "gateway",
                _meta: {
                    gateway: {
                        baseUrl: "https://api.example.com/v1",
                        headers: { Authorization: "Bearer sk-gw" },
                        providerName: "custom",
                    },
                },
            }),
        ).toEqual({
            baseUrl: "https://api.example.com/v1",
            headers: { Authorization: "Bearer sk-gw" },
            providerName: "custom",
            key: "sk-gw",
        });
        expect(
            gatewayFromAuthenticate({
                methodId: "gateway",
                _meta: { gateway: { headers: { "x-api-key": "tok-42" } } },
            }),
        ).toEqual({ headers: { "x-api-key": "tok-42" }, key: "tok-42" });
    });

    it("maps method ids onto provider routes", () => {
        expect(providerFromAuthMethodId("api-key")).toBeUndefined();
        expect(providerFromAuthMethodId("api-key:anthropic")).toBe("anthropic");
    });

    it("parses an optional provider and key", () => {
        expect(parseLoginArgv([])).toEqual({});
        expect(parseLoginArgv(["sk-test"])).toEqual({ key: "sk-test" });
        expect(parseLoginArgv(["--provider", "anthropic", "sk-ant"])).toEqual({
            provider: "anthropic",
            key: "sk-ant",
        });
        expect(parseLoginArgv(["--provider=openai"])).toEqual({ provider: "openai" });
    });

    it("maps the current route to the harness credential name", () => {
        expect(credentialEnvNames(undefined)).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);
        expect(credentialEnvNames("deepseek-official")).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);
        expect(credentialEnvNames("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
        expect(credentialEnvNames("openai")).toEqual(["OPENAI_API_KEY"]);
        expect(credentialEnvNames("moonshot")).toEqual(["MOONSHOT_API_KEY"]);
    });

    it("maps the current route to the harness base-URL credential name", () => {
        expect(credentialBaseUrlName(undefined)).toBe("DEEPSEEK_BASE_URL");
        expect(credentialBaseUrlName("deepseek-official")).toBe("DEEPSEEK_BASE_URL");
        expect(credentialBaseUrlName("anthropic")).toBe("ANTHROPIC_BASE_URL");
        expect(credentialBaseUrlName("openai")).toBe("OPENAI_BASE_URL");
        expect(credentialBaseUrlName("openai-proxy")).toBe("OPENAI_BASE_URL");
        expect(credentialBaseUrlName("moonshot")).toBe("MOONSHOT_BASE_URL");
    });
});

describe("ACP bridge credential wiring", () => {
    const bridge = readFileSync(join(import.meta.dirname, "../src/bridge/index.ts"), "utf8");
    const bundle = readFileSync(join(import.meta.dirname, "../src/bundle.ts"), "utf8");

    it("injects the host credentials service instead of writing the store itself", () => {
        expect(bridge).toContain(
            'inject = ["agents", "credentials", "llm", "agentDefaultModel", "sessionPersistence", "approval", "permissionPresets", "commands", "agentPresets", "skills", "subagents", "userQuestions"]',
        );
        expect(bridge).toContain('from "@deepseek-ai/dsh-credentials"');
        expect(bridge).toContain("ctx.credentials");
        expect(bridge).toContain("credentials.set(");
        expect(bridge).not.toContain("envCredentialPresent");
        expect(bundle).toContain("export const inject = bridge.inject");
        expect(bridge).not.toContain("writeFile");
        expect(bridge).not.toContain(".credentials.yaml");
        expect(bridge).not.toContain("no writable credential store");
        expect(bridge).not.toContain("no credentials service registered within 5s");
        expect(bridge).not.toContain("process.env[name] = baseUrl");
        expect(bridge).not.toContain('ctx.get("credentials")');
        expect(bridge).not.toContain('ctx.get("llm")');
        expect(bridge).not.toContain('ctx.get("approval")');
        expect(bridge).not.toContain('ctx.get("commands")');
        expect(bridge).not.toContain('ctx.get("skills")');
        expect(bridge).not.toContain('ctx.get("subagents")');
        expect(bridge).not.toContain('ctx.get("sessionPersistence")');
        expect(bridge).not.toContain('ctx.get("agentPresets")');
        expect(bridge).not.toContain('ctx.get("agentDefaultModel")');
        expect(bridge).not.toContain('ctx.get("permissionPresets")');
    });

    it("advertises the agent-preset roster as config option id agent", () => {
        expect(bridge).toMatch(/id: "agent",\s*name: "Agent"/);
        expect(bridge).toMatch(/case "agent":/);
        expect(bridge).not.toMatch(/id: "preset",\s*name: "Agent"/);
    });

    it("logs in through ctx.credentials, not a host-module lookup", () => {
        const login = readFileSync(join(import.meta.dirname, "../src/login.ts"), "utf8");
        expect(login).toContain('from "@deepseek-ai/dsh-credentials"');
        expect(login).toContain("ctx.credentials");
        expect(login).not.toContain("createRequire");
        expect(login).not.toContain("no writable credential store");
        expect(login).not.toContain('ctx.get("credentials")');
    });
});

describe("auth method ids and client capabilities", () => {
    it("classifies api-key and terminal method ids", () => {
        expect(isApiKeyAuthMethod("api-key")).toBe(true);
        expect(isApiKeyAuthMethod("api-key:anthropic")).toBe(true);
        expect(isApiKeyAuthMethod("browser")).toBe(false);
        expect(isApiKeyAuthMethod(undefined)).toBe(false);
        expect(isTerminalAuthMethod("terminal-login")).toBe(true);
        expect(isTerminalAuthMethod("terminal-login:anthropic")).toBe(true);
        expect(isTerminalAuthMethod("api-key")).toBe(false);
        expect(isTerminalAuthMethod(undefined)).toBe(false);
    });

    it("reads the terminal auth capability from auth.terminal or the Zed meta flag", () => {
        expect(clientSupportsTerminalAuth(undefined)).toBe(false);
        expect(clientSupportsTerminalAuth({})).toBe(false);
        expect(clientSupportsTerminalAuth({ auth: {} })).toBe(false);
        expect(clientSupportsTerminalAuth({ auth: { terminal: true } })).toBe(true);
        expect(clientSupportsTerminalAuth({ _meta: { "terminal-auth": true } })).toBe(true);
        expect(clientSupportsTerminalAuth({ _meta: { "terminal-auth": false } })).toBe(false);
    });

    it("reads url elicitation support only from a present capability object", () => {
        expect(clientSupportsUrlElicitation(undefined)).toBe(false);
        expect(clientSupportsUrlElicitation({})).toBe(false);
        expect(clientSupportsUrlElicitation({ elicitation: null })).toBe(false);
        expect(clientSupportsUrlElicitation({ elicitation: {} })).toBe(false);
        expect(clientSupportsUrlElicitation({ elicitation: { url: null } })).toBe(false);
        expect(clientSupportsUrlElicitation({ elicitation: { url: {} } })).toBe(true);
        expect(clientSupportsUrlElicitation({ elicitation: { form: {}, url: {} } })).toBe(true);
    });

    it("builds the terminal-auth launch spec for the current process or the dsh-acp bin", () => {
        const realArgv = process.argv;
        try {
            process.argv = ["/usr/bin/node", "/opt/dsh/dist/bin.js"];
            expect(terminalLaunchSpec(["login"])).toEqual({
                command: "/usr/bin/node",
                args: ["/opt/dsh/dist/bin.js", "login"],
            });
            process.argv = ["/usr/bin/node"];
            expect(terminalLaunchSpec(["login"])).toEqual({ command: "dsh-acp", args: ["login"] });
            process.argv = ["/usr/bin/dsh-acp", "/opt/dsh/dist/bin.js"];
            expect(terminalLaunchSpec(["login"])).toEqual({ command: "dsh-acp", args: ["login"] });
            process.argv = ["/usr/bin/node", "/opt/dsh/config.yml"];
            expect(terminalLaunchSpec(["login"])).toEqual({ command: "dsh-acp", args: ["login"] });
            process.argv = [];
            expect(terminalLaunchSpec(["login"])).toEqual({ command: "dsh-acp", args: ["login"] });
        } finally {
            process.argv = realArgv;
        }
    });
});
