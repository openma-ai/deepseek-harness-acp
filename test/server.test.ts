import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const bridgeApply = vi.fn()
const harness = { marker: 'profile-harness' }

vi.mock('../src/bridge/index.ts', () => ({
    inject: [],
    apply: bridgeApply,
}))

vi.mock('../src/bridge/self-harness.ts', () => ({
    selfHarness: () => harness,
}))

describe('ACP server plugin', () => {
    it('provides one reusable server that owns connection fibers', async () => {
        const mounted: Array<{ plugin: unknown; config: unknown }> = []
        const services = new Map<string, unknown>()
        const fiber = { dispose: vi.fn() }
        const ctx = {
            get(name: string) {
                return services.get(name)
            },
            provide(name: string, value: unknown) {
                services.set(name, value)
            },
            plugin(plugin: unknown, config: unknown) {
                mounted.push({ plugin, config })
                return fiber
            },
        }
        const serverPlugin = await import('../src/server.ts')
        serverPlugin.apply(ctx as never, { model: 'deepseek-v4' })
        const server = services.get('acpServer') as {
            connect(stream: unknown): unknown
        }
        const stream = {
            readable: new ReadableStream(),
            writable: new WritableStream(),
        }

        const connection = server.connect(stream)

        expect(connection).toBe(fiber)
        expect(mounted).toHaveLength(1)
        expect(mounted[0]?.config).toEqual({
            model: 'deepseek-v4',
            stream,
            harness,
        })
    })

    it('is idempotent when a profile already provides the ACP server', async () => {
        const ctx = new Context()
        const serverPlugin = await import('../src/server.ts')
        await ctx.plugin(serverPlugin)
        const first = ctx.get('acpServer')

        await ctx.plugin(serverPlugin)

        expect(ctx.get('acpServer')).toBe(first)
        await ctx.root.fiber.dispose()
    })
})
