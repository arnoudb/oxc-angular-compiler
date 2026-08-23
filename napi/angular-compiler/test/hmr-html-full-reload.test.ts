/**
 * Tests for issue #443: Vite 8 full-reloads component `.html` templates
 * after Angular HMR has already applied the update.
 *
 * Vite 8 treats any `.html` change with no remaining JS modules as a page
 * reload. Component templates are not page entries — we must (a) return the
 * owning component as a self-accepting JS module so Vite's pipeline does
 * not take that path, and (b) inject a client `vite:beforeFullReload`
 * guard for the empty-graph case.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HtmlTagDescriptor, ModuleNode, Plugin } from 'vite'
import { normalizePath } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { angular } from '../vite-plugin/index.js'
import {
  HMR_FULL_RELOAD_GUARD,
  markModuleSelfAccepting,
  shouldSuppressViteFullReload,
} from '../vite-plugin/utils/hmr-full-reload-guard.js'

let tempDir: string
let appDir: string
let templatePath: string
let stylePath: string
let componentPath: string

const COMPONENT_SOURCE = `
  import { Component } from '@angular/core';

  @Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css'],
  })
  export class AppComponent {}
`

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hmr-html-reload-'))
  appDir = join(tempDir, 'src', 'app')
  mkdirSync(appDir, { recursive: true })

  templatePath = join(appDir, 'app.component.html')
  stylePath = join(appDir, 'app.component.css')
  componentPath = join(appDir, 'app.component.ts')

  writeFileSync(templatePath, '<h1>Hello</h1>')
  writeFileSync(stylePath, 'h1 { color: red; }')
  writeFileSync(componentPath, COMPONENT_SOURCE)
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function getAngularPlugin() {
  const plugin = angular({ liveReload: true }).find(
    (candidate) => candidate.name === '@oxc-angular/vite',
  )
  if (!plugin) throw new Error('Failed to find @oxc-angular/vite plugin')
  return plugin
}

function createMockServer(modulesById: Map<string, ModuleNode> = new Map()) {
  const wsMessages: any[] = []
  return {
    watcher: { unwatch() {}, on() {}, emit() {} },
    ws: {
      send(msg: any) {
        wsMessages.push(msg)
      },
      on() {},
    },
    moduleGraph: {
      getModuleById: (id: string) => modulesById.get(id) ?? null,
      getModulesByFile: (file: string) => {
        const mod = modulesById.get(file)
        return mod ? new Set([mod]) : new Set()
      },
      invalidateModule() {},
    },
    middlewares: { use() {} },
    config: { root: tempDir },
    _wsMessages: wsMessages,
  }
}

async function callPluginHook<TArgs extends unknown[], TResult>(
  hook:
    | {
        handler: (...args: TArgs) => TResult
      }
    | ((...args: TArgs) => TResult)
    | undefined,
  ...args: TArgs
): Promise<TResult | undefined> {
  if (!hook) return undefined
  if (typeof hook === 'function') return hook(...args)
  return hook.handler(...args)
}

async function setupPluginWithServer(plugin: Plugin, server: ReturnType<typeof createMockServer>) {
  await callPluginHook(
    plugin.config as Plugin['config'],
    {} as any,
    { command: 'serve', mode: 'development' } as any,
  )
  await callPluginHook(
    plugin.configResolved as Plugin['configResolved'],
    {
      build: {},
      isProduction: false,
    } as any,
  )
  if (typeof plugin.configureServer === 'function') {
    await (plugin.configureServer as Function)(server)
  }
  return server
}

async function transformComponent(plugin: Plugin) {
  if (!plugin.transform || typeof plugin.transform === 'function') {
    throw new Error('Expected plugin transform handler')
  }
  await plugin.transform.handler.call(
    { error() {}, warn() {} } as any,
    COMPONENT_SOURCE,
    componentPath,
  )
}

describe('shouldSuppressViteFullReload (issue #443)', () => {
  it('does not suppress when no component HMR was just dispatched', () => {
    expect(shouldSuppressViteFullReload('/src/app/app.component.html', false)).toBe(false)
    expect(shouldSuppressViteFullReload('*', false)).toBe(false)
    expect(shouldSuppressViteFullReload(undefined, false)).toBe(false)
  })

  it('suppresses leftover Vite HTML reloads after component HMR', () => {
    expect(shouldSuppressViteFullReload('/src/app/app.component.html', true)).toBe(true)
    expect(shouldSuppressViteFullReload('/src/app/foo.htm', true)).toBe(true)
    expect(shouldSuppressViteFullReload('*', true)).toBe(true)
    expect(shouldSuppressViteFullReload(undefined, true)).toBe(true)
    expect(shouldSuppressViteFullReload('/src/app/app.component.html?t=1', true)).toBe(true)
  })

  it('never suppresses the app HTML entry or non-HTML files', () => {
    expect(shouldSuppressViteFullReload('/index.html', true)).toBe(false)
    expect(shouldSuppressViteFullReload('index.html', true)).toBe(false)
    expect(shouldSuppressViteFullReload('/src/index.html', true)).toBe(false)
    expect(shouldSuppressViteFullReload('/src/app/app.component.ts', true)).toBe(false)
    expect(shouldSuppressViteFullReload('/src/styles.css', true)).toBe(false)
    // Failed HMR (`angular:invalidate`) uses path `/` so it is not swallowed.
    expect(shouldSuppressViteFullReload('/', true)).toBe(false)
  })
})

describe('markModuleSelfAccepting', () => {
  it('marks the module and its Vite 6+ _clientModule as self-accepting', () => {
    const client = { isSelfAccepting: false } as ModuleNode
    const mixed = { isSelfAccepting: false, _clientModule: client } as ModuleNode & {
      _clientModule: ModuleNode
    }

    expect(markModuleSelfAccepting(mixed)).toBe(mixed)
    expect(mixed.isSelfAccepting).toBe(true)
    expect(client.isSelfAccepting).toBe(true)
  })
})

describe('handleHotUpdate - issue #443 HTML full-reload', () => {
  it('injects a vite:beforeFullReload guard via transformIndexHtml', async () => {
    const plugin = getAngularPlugin()
    await setupPluginWithServer(plugin, createMockServer())

    expect(
      plugin.transformIndexHtml,
      'expected transformIndexHtml to inject the client guard',
    ).toBeDefined()

    const tags = await callPluginHook(
      plugin.transformIndexHtml as Plugin['transformIndexHtml'],
      '<html></html>',
      { path: '/index.html', filename: 'index.html', server: {} as any } as any,
    )

    const injected = Array.isArray(tags)
      ? tags
      : tags && typeof tags === 'object' && 'tags' in tags
        ? (tags.tags as HtmlTagDescriptor[])
        : []
    const script = injected.find((tag) => tag.tag === 'script')
    expect(script, 'expected a script tag').toBeDefined()
    expect(script?.children).toContain('vite:beforeFullReload')
    expect(script?.children).toContain('angular:component-update')
    expect(script?.children).toBe(HMR_FULL_RELOAD_GUARD)
  })

  it('does not inject the guard when liveReload is disabled', async () => {
    const plugin = angular({ liveReload: false }).find(
      (candidate) => candidate.name === '@oxc-angular/vite',
    )!
    await setupPluginWithServer(plugin, createMockServer())

    const tags = await callPluginHook(
      plugin.transformIndexHtml as Plugin['transformIndexHtml'],
      '<html></html>',
      { path: '/index.html', filename: 'index.html', server: {} as any } as any,
    )
    expect(tags).toBeUndefined()
  })

  it('returns the owning component as a self-accepting JS module, not the HTML module', async () => {
    const plugin = getAngularPlugin()
    const componentMod = {
      id: componentPath,
      type: 'js',
      isSelfAccepting: false,
      url: componentPath,
    } as ModuleNode
    const mockServer = createMockServer(new Map([[componentPath, componentMod]]))
    await setupPluginWithServer(plugin, mockServer)
    await transformComponent(plugin)

    const componentHtmlFile = normalizePath(templatePath)
    const htmlMod = { id: componentHtmlFile, type: 'asset' } as ModuleNode
    const ctx = {
      file: componentHtmlFile,
      timestamp: Date.now(),
      modules: [htmlMod],
      read: async () => '',
      server: mockServer,
    }

    const result = await (plugin.handleHotUpdate as Function).call(plugin, ctx)

    expect(mockServer._wsMessages).toContainEqual(
      expect.objectContaining({ type: 'custom', event: 'angular:component-update' }),
    )
    // Vite 8 full-reloads when every remaining module has type !== 'js'.
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(componentMod)
    expect(result[0].type).toBe('js')
    expect(result[0].isSelfAccepting).toBe(true)
    expect(result).not.toContain(htmlMod)
  })
})
