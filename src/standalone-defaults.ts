import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

const PERMISSION_FILENAME = "acp-standalone-permission.json";
const MODEL_FILENAME = "acp-standalone-model.json";

export interface StandaloneModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}

function legacySettings(home: string): Record<string, unknown> {
    const path = join(home, "settings.yaml");
    if (!existsSync(path)) return {};
    const parsed: unknown = parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown> : {};
}

async function writeJson(home: string, filename: string, value: object): Promise<void> {
    const path = join(home, filename);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await mkdir(home, { recursive: true });
        await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

/** Standalone ACP has no dsh profile, so its selection has its own small store. */
export function readStandalonePermission(home: string): string | undefined {
    const ownPath = join(home, PERMISSION_FILENAME);
    if (existsSync(ownPath)) {
        const value = JSON.parse(readFileSync(ownPath, "utf8")) as { permissionMode?: unknown };
        return typeof value.permissionMode === "string" ? value.permissionMode : undefined;
    }
    // Honor the setting written by dsh releases before profile-backed forms.
    const value = legacySettings(home)["permission"] as { defaultPreset?: unknown } | undefined;
    return typeof value?.defaultPreset === "string" ? value.defaultPreset : undefined;
}

export async function writeStandalonePermission(home: string, permissionMode: string): Promise<void> {
    await writeJson(home, PERMISSION_FILENAME, { permissionMode });
}

export function readStandaloneModel(home: string): StandaloneModelSelection | undefined {
    const path = join(home, MODEL_FILENAME);
    const value: Record<string, unknown> = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        : (legacySettings(home)["agent-default-model"] as Record<string, unknown> | undefined) ?? {};
    if (typeof value["provider"] !== "string" || typeof value["model"] !== "string") return undefined;
    return {
        provider: value["provider"],
        model: value["model"],
        ...(typeof value["reasoningEffort"] === "string" ? { reasoningEffort: value["reasoningEffort"] } : {}),
    };
}

export async function writeStandaloneModel(home: string, model: StandaloneModelSelection): Promise<void> {
    await writeJson(home, MODEL_FILENAME, model);
}
