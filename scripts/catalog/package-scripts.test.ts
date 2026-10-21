import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// How the two catalog commands are reached, and the package that reads workbook files. The tests read package.json and the lockfile as files, the
// way scripts/secrets/plan.test.ts reads wrangler.jsonc.
const root = resolve(__dirname, '../..')
const json = (file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8'))

describe('package.json', () => {
  const pkg = json('package.json')

  it.each([
    ['catalog:export', 'tsx scripts/catalog-export.ts'],
    ['catalog:upload', 'tsx scripts/catalog-upload.ts'],
  ])('has an npm script %s that runs %s', (name, command) => {
    expect(pkg.scripts[name]).toBe(command)
    expect(existsSync(resolve(root, command.replace('tsx ', ''))), `${command.replace('tsx ', '')} exists`).toBe(true)
  })

  it('has exceljs as a devDependency only, since the Worker never reads a workbook file and must not bundle the library', () => {
    expect(pkg.devDependencies.exceljs).toMatch(/^[\^~]?\d/)
    expect(pkg.dependencies?.exceljs).toBeUndefined()
  })
})

describe('package-lock.json', () => {
  const lock = json('package-lock.json')

  it('locks exceljs, so CI\'s npm ci installs it', () => {
    expect(lock.packages['node_modules/exceljs']).toBeDefined()
    expect(lock.packages[''].devDependencies.exceljs).toBeDefined()
  })

  it('still holds the platform-specific rolldown bindings npm drops after an install (README: Troubleshooting), including the one CI runs on', () => {
    expect(lock.packages['node_modules/@rolldown/binding-linux-x64-gnu']).toBeDefined()
    expect(lock.packages['node_modules/@rolldown/binding-darwin-arm64']).toBeDefined()
  })
})
