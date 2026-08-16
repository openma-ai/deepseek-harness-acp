import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    advertisedAuthMethods,
    apiKeyAuthMethods,
    apiKeyFromAuthenticate,
    credentialEnvNames,
    gatewayFromAuthenticate,
    parseLoginArgv,
    providerFromAuthMethodId,
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

    it("adds browser and gateway only when the client can use them", () => {
        expect(advertisedAuthMethods([], undefined, { NODE_ENV: "test" }).map((method) => method.id))
            .toEqual(["api-key"]);
        expect(
            advertisedAuthMethods([], { auth: { _meta: { gateway: true } } }, { NODE_ENV: "test" })
                .map((method) => method.id),
        ).toEqual(["api-key", "gateway"]);
        expect(advertisedAuthMethods([], undefined, { NODE_ENV: "production" }).map((method) => method.id))
            .toEqual(["api-key", "browser"]);
        expect(
            advertisedAuthMethods(
                [],
                { auth: { _meta: { gateway: true } } },
                { NODE_ENV: "production" },
            ).map((method) => method.id),
        ).toEqual(["api-key", "browser", "gateway"]);
        expect(
            advertisedAuthMethods(
                [],
                { auth: { _meta: { gateway: true } } },
                { NODE_ENV: "production", NO_BROWSER: "1" },
            ).map((method) => method.id),
        ).toEqual(["api-key", "gateway"]);
    });

    it("keeps per-provider api-key methods in front of the shared browser and gateway methods", () => {
        expect(
            advertisedAuthMethods(
                [
                    { id: "deepseek-official", name: "DeepSeek" },
                    { id: "anthropic", name: "Anthropic" },
                ],
                { auth: { _meta: { gateway: true } } },
                { NODE_ENV: "production" },
            ).map((method) => method.id),
        ).toEqual(["api-key:deepseek-official", "api-key:anthropic", "browser", "gateway"]);
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

    it("mounts cordis-host-runner so the cordis agent preset can activate tool-cordis", () => {
        const patch = readFileSync(join(import.meta.dirname, "../cordis.patch.yml"), "utf8");
        expect(patch).toMatch(/id:\s*cordis-host-runner/);
        expect(patch).toContain("@deepseek-ai/dsh-cordis-host-runner");
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
