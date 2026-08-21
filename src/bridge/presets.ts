/**
 * Roster copy for the uncategorized ACP config option that switches the
 * mounted agent composition.
 *
 * This is not a generic “preset” slash and not `category: "mode"` (that
 * slot is permission). Clients switch whatever select the agent advertises;
 * dsh-acp advertises `id: "agent"` when `ctx.agentPresets` is composed.
 * Authoring (copy/rm/default) stays on the Web settings page.
 */

/** One roster row as `ctx.agentPresets.list()` returns it. */
export interface PresetRow {
    id: string;
    name?: string;
    description?: string;
    trust?: "system" | "user";
    broken?: string;
}

/** One selectable value in the ACP `agent` config option. */
export interface PresetSelectChoice {
    value: string;
    name: string;
    description?: string;
}

/** ACP select group (Backchat `flattenSelectOptions` already flattens these). */
export interface PresetSelectGroup {
    group: string;
    name: string;
    options: PresetSelectChoice[];
}

/** Uncategorized agent-composition select (`id: "agent"`, never `category`). */
export interface AgentConfigOption {
    type: "select";
    id: "agent";
    name: "Agent";
    currentValue: string;
    options: PresetSelectChoice[] | PresetSelectGroup[];
}

const BUILT_IN_PRESET_NAMES: Readonly<Record<string, string>> = {
    standard: "Standard",
    code: "Code",
    minimal: "Minimal",
    cordis: "Cordis",
};

/**
 * Display name for one roster row: the row's own name, else the id.
 * @param preset - roster row.
 * @returns chip / dropdown label.
 */
export function presetDisplayName(preset: PresetRow): string {
    const builtInName = BUILT_IN_PRESET_NAMES[preset.id];
    if (builtInName !== undefined) return builtInName;
    const name = preset.name?.trim();
    return name !== undefined && name.length > 0 ? name : preset.id;
}

/**
 * Dropdown description: broken reason first, else the row's own blurb.
 * @param preset - roster row.
 * @returns description, or undefined when there is nothing to show.
 */
export function presetDescription(preset: PresetRow): string | undefined {
    if (preset.broken !== undefined && preset.broken.length > 0) {
        return `Broken: ${preset.broken}`;
    }
    const description = preset.description?.trim();
    return description !== undefined && description.length > 0 ? description : undefined;
}

function asChoice(preset: PresetRow): PresetSelectChoice {
    const description = presetDescription(preset);
    return {
        value: preset.id,
        name: presetDisplayName(preset),
        ...(description !== undefined ? { description } : {}),
    };
}

/**
 * Select choices for the `agent` config option. Groups system vs user when
 * both trusts are present; otherwise a flat list. Broken rows stay listed.
 * @param roster - `agentPresets.list()` result.
 * @returns ACP select `options`.
 */
export function presetSelectOptions(
    roster: readonly PresetRow[],
): PresetSelectChoice[] | PresetSelectGroup[] {
    const system = roster.filter((preset) => preset.trust === "system");
    const user = roster.filter((preset) => preset.trust === "user");
    const other = roster.filter((preset) => preset.trust !== "system" && preset.trust !== "user");
    if (system.length > 0 && user.length > 0) {
        const groups: PresetSelectGroup[] = [
            { group: "system", name: "System", options: system.map(asChoice) },
            { group: "user", name: "User", options: user.map(asChoice) },
        ];
        if (other.length > 0) {
            groups.push({ group: "other", name: "Other", options: other.map(asChoice) });
        }
        return groups;
    }
    return roster.map(asChoice);
}

/**
 * Build the uncategorized `agent` config option.
 * @param roster - current roster.
 * @param currentValue - the session's mounted composition id.
 * @returns ACP select option, or undefined when the roster is too small to pick from.
 */
export function agentConfigOption(
    roster: readonly PresetRow[],
    currentValue: string,
): AgentConfigOption | undefined {
    if (roster.length < 2) return undefined;
    return {
        type: "select",
        id: "agent",
        name: "Agent",
        currentValue,
        options: presetSelectOptions(roster),
    };
}

/**
 * ACP `session/set_config_option` `value`: a bare string (TS SDK / Zed) or
 * rust-sdk 2.0 `{ value: "…" }` / `{ type: "value_id", value: "…" }`.
 * @param value - wire `params.value`.
 * @returns the select id, or undefined when the payload is not a string id.
 */
export function configOptionValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object" && "value" in value) {
        const inner = (value as { value: unknown }).value;
        if (typeof inner === "string") return inner;
    }
    return undefined;
}

/** Config ids that switch the mounted agent composition on this bridge. */
export function isAgentCompositionConfigId(configId: string): boolean {
    return configId === "agent" || configId === "preset" || configId === "agent-preset";
}
