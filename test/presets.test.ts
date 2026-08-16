import { describe, expect, it } from "vitest";
import {
    agentConfigOption,
    configOptionValue,
    isAgentCompositionConfigId,
    presetDescription,
    presetDisplayName,
    presetSelectOptions,
    type PresetRow,
} from "../src/bridge/presets.ts";

const roster: PresetRow[] = [
    {
        id: "cordis",
        name: "Cordis",
        description: "Inspect and author the live composition",
        trust: "system",
    },
    { id: "standard", name: "Standard", trust: "system" },
    { id: "broken-user", trust: "user", broken: "missing cordis.yml" },
];

describe("agent config option copy", () => {
    it("uses the row name, broken reason, and groups system vs user", () => {
        expect(presetDisplayName({ id: "cordis" })).toBe("Creator");
        expect(presetDisplayName({ id: "cordis", name: "Cordis" })).toBe("Creator");
        expect(presetDescription({ id: "x", description: "hello" })).toBe("hello");
        expect(presetDescription({ id: "x", broken: "no yaml", description: "hello" })).toBe(
            "Broken: no yaml",
        );

        const options = presetSelectOptions(roster);
        expect(options[0]).toMatchObject({ group: "system", name: "System" });
        expect(options[1]).toMatchObject({ group: "user", name: "User" });
        const user = (options[1] as { options: Array<{ value: string; description?: string }> }).options;
        expect(user[0]).toMatchObject({
            value: "broken-user",
            name: "broken-user",
            description: "Broken: missing cordis.yml",
        });

        const option = agentConfigOption(roster, "cordis");
        expect(option).toMatchObject({
            type: "select",
            id: "agent",
            name: "Agent",
            currentValue: "cordis",
        });
        const system = option?.options[0] as {
            group: string;
            options: Array<{ value: string; name: string }>;
        };
        expect(system.group).toBe("system");
        expect(system.options[0]).toMatchObject({ value: "cordis", name: "Creator" });
        expect(option).not.toHaveProperty("category");
        expect(agentConfigOption([roster[0]!], "cordis")).toBeUndefined();
    });

    it("stays a flat list when trust is missing", () => {
        const options = presetSelectOptions([{ id: "a" }, { id: "b", name: "Bee" }]);
        expect(options).toEqual([
            { value: "a", name: "a" },
            { value: "b", name: "Bee" },
        ]);
    });
});

describe("configOptionValue", () => {
    it("accepts a string and rust-sdk object values", () => {
        expect(configOptionValue("cordis")).toBe("cordis");
        expect(configOptionValue({ value: "cordis" })).toBe("cordis");
        expect(configOptionValue({ type: "value_id", value: "standard" })).toBe("standard");
        expect(configOptionValue({ value: 1 })).toBeUndefined();
        expect(configOptionValue(true)).toBeUndefined();
    });
});

describe("isAgentCompositionConfigId", () => {
    it("matches the ids Backchat already special-cases, not a /preset slash", () => {
        expect(isAgentCompositionConfigId("agent")).toBe(true);
        expect(isAgentCompositionConfigId("preset")).toBe(true);
        expect(isAgentCompositionConfigId("agent-preset")).toBe(true);
        expect(isAgentCompositionConfigId("mode")).toBe(false);
        expect(isAgentCompositionConfigId("model")).toBe(false);
    });
});
