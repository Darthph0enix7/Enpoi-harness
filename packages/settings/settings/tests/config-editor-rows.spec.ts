/** ConfigEditor row insert/remove: top-level ownership, recomposition validation, rollback. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

it('inserts a top-level row, composes it, and removes it again', async () => {
  const { ctx, profile } = await configurationFixture()
  await ctx.configEditor.insert({ id: 'preset-x', name: 'cordis:probe', config: { ordinary: 'row' } })
  expect(ctx.configEditor.entries().some(entry => entry.options.id === 'preset-x')).toBe(true)
  const inserted = readFileSync(profile.patchPath, 'utf8')
  expect(inserted).toContain('id: preset-x')
  expect(inserted).toContain('name: cordis:probe')

  await ctx.configEditor.remove('preset-x')
  expect(ctx.configEditor.entries().some(entry => entry.options.id === 'preset-x')).toBe(false)
  expect(readFileSync(profile.patchPath, 'utf8')).not.toContain('preset-x')
})

it('refuses a duplicate id without touching the document', async () => {
  const { ctx, profile } = await configurationFixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.insert({ id: 'first', name: 'cordis:probe', config: { ordinary: 'again' } }))
    .rejects.toThrow('already exists')
  await ctx.configEditor.insert({ id: 'preset-x', name: 'cordis:probe', config: { ordinary: 'row' } })
  const withRow = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.insert({ id: 'preset-x', name: 'cordis:probe', config: { ordinary: 'row' } }))
    .rejects.toThrow('already exists')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(withRow)
  expect(before).not.toContain('preset-x')
})

it('rolls the document back when the inserted row fails activation', async () => {
  const { ctx, profile } = await configurationFixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.insert({ id: 'broken-row', name: 'cordis:probe', config: { ordinary: 42 } }))
    .rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.configEditor.entries().some(entry => entry.options.id === 'broken-row')).toBe(false)
})

it('refuses to remove a row owned by another layer', async () => {
  const { ctx, profile } = await configurationFixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(ctx.configEditor.remove('first')).rejects.toThrow('not removable')
  await expect(ctx.configEditor.remove('missing-row')).rejects.toThrow('not removable')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})
