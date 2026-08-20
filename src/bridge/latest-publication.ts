/**
 * Per-key generation gate for async replace-whole-state publications.
 *
 * A later snapshot owns the key immediately, not when its producer settles.
 * This prevents a slower, older read from overwriting a newer catalogue.
 */
export class LatestPublication {
    private readonly revisions = new Map<string, number>();

    async run<T>(key: string, produce: () => Promise<T>, publish: (value: T) => void): Promise<void> {
        const revision = (this.revisions.get(key) ?? 0) + 1;
        this.revisions.set(key, revision);
        const value = await produce();
        if (this.revisions.get(key) !== revision) return;
        publish(value);
    }

    invalidate(key: string): void {
        this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    }
}
