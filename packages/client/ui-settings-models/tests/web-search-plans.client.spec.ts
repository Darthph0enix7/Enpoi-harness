/**
 * Web-search plan facts: shipped rows are the frozen defaults, and operator
 * overrides merge over them field by field.
 */
import { expect, it } from 'vitest'
import {
  parseWebSearchPlanOverrides,
  resolveWebSearchPlan,
  SHIPPED_WEB_SEARCH_PLANS,
} from '../src/client/web-search-plans.ts'

it('ships frozen plan rows for the hosted and premium providers', () => {
  expect(SHIPPED_WEB_SEARCH_PLANS.map(row => row.provider)).toEqual(['exa', 'brave', 'tavily'])
  for (const row of SHIPPED_WEB_SEARCH_PLANS) {
    expect(row.plan.length).toBeGreaterThan(0)
    expect(row.price.length).toBeGreaterThan(0)
    expect(row.limits.length).toBeGreaterThan(0)
    expect(row.link.startsWith('https://')).toBe(true)
  }
})

it('parses only well-formed override fields and drops empty entries', () => {
  expect(parseWebSearchPlanOverrides(undefined)).toEqual({})
  expect(parseWebSearchPlanOverrides([])).toEqual({})
  expect(parseWebSearchPlanOverrides({ uiPreferences: 'nope' })).toEqual({})
  expect(parseWebSearchPlanOverrides({ uiPreferences: { webSearchPlans: 'nope' } })).toEqual({})
  expect(parseWebSearchPlanOverrides({ uiPreferences: { webSearchPlans: { exa: 'nope' } } })).toEqual({})
  expect(parseWebSearchPlanOverrides({ uiPreferences: { webSearchPlans: { exa: { plan: '' } } } })).toEqual({})
  expect(parseWebSearchPlanOverrides({
    uiPreferences: { webSearchPlans: { exa: { price: '$1', limits: 7, link: '' } } },
  })).toEqual({ exa: { price: '$1' } })
  expect(parseWebSearchPlanOverrides({
    uiPreferences: { webSearchPlans: { exa: { plan: 'P' } } },
  })).toEqual({ exa: { plan: 'P' } })
  expect(parseWebSearchPlanOverrides({
    uiPreferences: { webSearchPlans: { exa: { limits: 'L' } } },
  })).toEqual({ exa: { limits: 'L' } })
  expect(parseWebSearchPlanOverrides({
    uiPreferences: { webSearchPlans: { exa: { link: 'https://exa.test' } } },
  })).toEqual({ exa: { link: 'https://exa.test' } })
  expect(parseWebSearchPlanOverrides({
    uiPreferences: {
      webSearchPlans: {
        exa: { plan: 'Pro', price: '$20', limits: 'faster', link: 'https://exa.test' },
      },
    },
  })).toEqual({ exa: { plan: 'Pro', price: '$20', limits: 'faster', link: 'https://exa.test' } })
})

it('resolves the shipped row, a provider with no row, and a merged override', () => {
  const shipped = resolveWebSearchPlan('tavily')
  expect(shipped?.price).toBe('1,000 free searches a month')
  expect(resolveWebSearchPlan('searxng')).toBeUndefined()
  const merged = resolveWebSearchPlan('tavily', { tavily: { price: '$0 promo' } })
  expect(merged).toEqual({ ...shipped, price: '$0 promo', provider: 'tavily' })
})
