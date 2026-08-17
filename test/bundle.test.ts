import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const bundle = await import('../src/bundle.ts')

describe('profile bridge transport', () => {
    it('publishes the reusable server as a package plugin entry', () => {
        const require = createRequire(import.meta.url)
        expect(require.resolve('@openma/deepseek-harness-acp/server'))
            .toBe(join(import.meta.dirname, '../dist/server.js'))
    })

    it('composes the complete ACP plugin before the stdio transport adapter', () => {
        const patch = loadOverlayPatches(
            'dsh-acp-test',
            join(import.meta.dirname, '../cordis.patch.yml'),
        )
        const rows = composeEntries([patch])
        const server = rows.find((row) => row.id === 'acp-plugin')
        const stdio = rows.find((row) => row.id === 'acp-bridge')

        expect(server).toMatchObject({
            id: 'acp-plugin',
            name: '@openma/deepseek-harness-acp/plugin',
        })
        expect(stdio).toMatchObject({
            id: 'acp-bridge',
            name: '@openma/deepseek-harness-acp/stdio',
        })
        expect(rows.indexOf(server as never)).toBeLessThan(rows.indexOf(stdio as never))
    })

    it('binds the profile stdio adapter through the reusable ACP server', () => {
        const connect = vi.fn()
        const ctx = {
            get(name: string) {
                return name === 'acpServer' ? { connect } : undefined
            },
        }

        bundle.apply(ctx as never)

        expect(connect).toHaveBeenCalledOnce()
        expect(connect.mock.calls[0]?.[0]).toMatchObject({
            readable: expect.any(ReadableStream),
            writable: expect.any(WritableStream),
        })
    })

    it('keeps the stdio bridge usable with an older standalone bundle patch', () => {
        const mounted: Array<{ plugin: unknown; config: Record<string, unknown> }> = []
        const fiber = { marker: 'legacy-profile-connection' }
        const ctx = {
            get() {
                return undefined
            },
            plugin(plugin: unknown, config: Record<string, unknown>) {
                mounted.push({ plugin, config })
                return fiber
            },
        }

        const connection = bundle.apply(ctx as never)

        expect(connection).toBe(fiber)
        expect(mounted).toHaveLength(1)
        expect(mounted[0]?.config).toMatchObject({
            harness: {
                createUserMessage: expect.any(Function),
                sessionId: expect.any(Function),
            },
            stream: {
                readable: expect.any(ReadableStream),
                writable: expect.any(WritableStream),
            },
        })
    })

    it('adapts caller-owned Node pipes to one ACP message stream', async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        const stream = bundle.nodeAcpStream(input, output)
        const read = stream.readable.getReader().read()

        input.write('{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}\n')

        await expect(read).resolves.toEqual({
            done: false,
            value: { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} },
        })
    })
})
