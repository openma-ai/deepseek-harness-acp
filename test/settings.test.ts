import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSettings, SettingsError } from "../src/settings.ts";

const ENV_KEYS = [
    "DSH_MODEL",
    "DSH_PROVIDER",
    "DSH_ACP_MODELS",
    "DSH_PERMISSION_MODE",
    "DSH_SESSION_ROOT",
    "DSH_SYSTEM_PROMPT",
    "DSH_REASONING_EFFORT",
    "DSH_MAX_TOKENS",
    "DSH_BASH_TIMEOUT_MS",
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("resolveSettings", () => {
    it("leaves provider and model unset so the composition default rules", () => {
        const settings = resolveSettings([]);
        expect(settings.provider).toBeUndefined();
        expect(settings.model).toBeUndefined();
        expect(settings.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
        expect(settings.permissionMode).toBeUndefined();
        expect(settings.thinking).toBe(true);
        expect(settings.reasoningEffort).toBe("high");
        expect(settings.sessionRoot).toContain(".dsh-acp");
    });

    it("lets flags win over environment variables", () => {
        process.env["DSH_MODEL"] = "env-model";
        process.env["DSH_PERMISSION_MODE"] = "read-only";
        const settings = resolveSettings([
            "--model",
            "flag-model",
            "--models=a, b",
            "--bundle",
            "/plugins/creator",
            "--bundle=/plugins/team-policy",
            "--no-thinking",
        ]);
        expect(settings.model).toBe("flag-model");
        expect(settings.models).toEqual(["a", "b"]);
        expect(settings.bundles).toEqual(["/plugins/creator", "/plugins/team-policy"]);
        expect(settings.permissionMode).toBe("read-only");
        expect(settings.thinking).toBe(false);
    });

    it("rejects invalid values loudly", () => {
        expect(() => resolveSettings(["--permission-mode", "yolo"])).toThrow(SettingsError);
        expect(() => resolveSettings(["--max-tokens", "-3"])).toThrow(SettingsError);
        expect(() => resolveSettings(["--reasoning-effort", "extreme"])).toThrow(SettingsError);
        expect(() => resolveSettings(["--bundle"])).toThrow(/requires a value/);
        expect(() => resolveSettings(["--bundle="])).toThrow(/requires a value/);
        expect(() => resolveSettings(["--unknown-flag"])).toThrow(SettingsError);
        expect(() => resolveSettings(["positional"])).toThrow(SettingsError);
    });
});
